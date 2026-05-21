use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::path_util::{augmented_path, resolve_claude_bin};

#[derive(Default, Clone)]
pub struct ClaudeState {
    inflight: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

#[derive(Clone, Serialize, Type, Event)]
pub struct ClaudeStreamEvent {
    pub request_id: String,
    pub line: String,
}

#[derive(Clone, Serialize, Type, Event)]
pub struct ClaudeStderrEvent {
    pub request_id: String,
    pub line: String,
}

#[derive(Clone, Serialize, Type, Event)]
pub struct ClaudeDoneEvent {
    pub request_id: String,
    pub code: Option<i32>,
    pub error: Option<String>,
}

#[derive(Deserialize, Type)]
pub struct ClaudeSendArgs {
    pub request_id: String,
    pub prompt: String,
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub claude_bin: Option<String>,
    #[serde(default)]
    pub extra_dirs: Vec<String>,
    #[serde(default)]
    pub skip_permissions: bool,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// Replaces the default system prompt for this session.
    pub system_prompt: Option<String>,
    /// Appended after the default system prompt for this session.
    pub append_system_prompt: Option<String>,
    /// Reasoning effort level: "low" | "medium" | "high" | "xhigh" | "max".
    pub effort: Option<String>,
}

fn build_claude_argv(args: &ClaudeSendArgs, bin: &Path) -> Vec<OsString> {
    fn push_arg_pair(argv: &mut Vec<OsString>, flag: &str, value: &str) {
        argv.push(flag.into());
        argv.push(value.into());
    }

    let mut argv = vec![bin.as_os_str().to_os_string()];
    push_arg_pair(&mut argv, "--output-format", "stream-json");
    argv.push("--include-partial-messages".into());
    argv.push("--verbose".into());

    if args.skip_permissions {
        argv.push("--dangerously-skip-permissions".into());
    } else if let Some(mode) = args.permission_mode.as_deref() {
        if !mode.is_empty() && mode != "default" {
            push_arg_pair(&mut argv, "--permission-mode", mode);
        }
    }

    if let Some(model) = args.model.as_deref() {
        if !model.is_empty() {
            push_arg_pair(&mut argv, "--model", model);
        }
    }
    if let Some(sp) = args.system_prompt.as_deref() {
        if !sp.is_empty() {
            push_arg_pair(&mut argv, "--system-prompt", sp);
        }
    }
    if let Some(asp) = args.append_system_prompt.as_deref() {
        if !asp.is_empty() {
            push_arg_pair(&mut argv, "--append-system-prompt", asp);
        }
    }
    if let Some(effort) = args.effort.as_deref() {
        if !effort.is_empty() {
            push_arg_pair(&mut argv, "--effort", effort);
        }
    }
    if let Some(sid) = args.resume_session_id.as_deref() {
        push_arg_pair(&mut argv, "--resume", sid);
    }
    for dir in &args.extra_dirs {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            push_arg_pair(&mut argv, "--add-dir", trimmed);
        }
    }

    push_arg_pair(&mut argv, "-p", &args.prompt);
    argv
}

#[tauri::command]
#[specta::specta]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    args: ClaudeSendArgs,
) -> Result<(), String> {
    let bin = resolve_claude_bin(args.claude_bin.clone()).ok_or("claude binary not found")?;

    if !std::path::Path::new(&args.cwd).is_dir() {
        return Err(format!(
            "工作目录不存在: {}（项目路径解析有误，请到该项目重新打开历史会话）",
            args.cwd
        ));
    }

    let argv = build_claude_argv(&args, &bin);
    let mut cmd = Command::new(&bin);
    cmd.args(argv.into_iter().skip(1));
    cmd.current_dir(&args.cwd);
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "dumb");
    cmd.env("CLAUDE_CODE_NONINTERACTIVE", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child: Child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut inflight = state.inflight.lock();
        inflight.insert(args.request_id.clone(), cancel_tx);
    }

    let app_for_stdout = app.clone();
    let req_id_stdout = args.request_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ClaudeStreamEvent {
                request_id: req_id_stdout.clone(),
                line,
            }
            .emit(&app_for_stdout);
        }
    });

    let app_for_stderr = app.clone();
    let req_id_stderr = args.request_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ClaudeStderrEvent {
                request_id: req_id_stderr.clone(),
                line,
            }
            .emit(&app_for_stderr);
        }
    });

    let req_id_for_done = args.request_id.clone();
    let app_for_done = app.clone();
    let inflight_for_cleanup = state.inflight.clone();

    tokio::spawn(async move {
        let outcome = tokio::select! {
            status = child.wait() => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                match status {
                    Ok(s) => Ok(s.code()),
                    Err(e) => Err(e.to_string()),
                }
            }
            _ = &mut cancel_rx => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                Ok(None)
            }
        };
        let (code, err) = match outcome {
            Ok(c) => (c, None),
            Err(e) => (None, Some(e)),
        };
        inflight_for_cleanup.lock().remove(&req_id_for_done);
        let _ = ClaudeDoneEvent {
            request_id: req_id_for_done,
            code,
            error: err,
        }
        .emit(&app_for_done);
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn claude_cancel(state: State<'_, ClaudeState>, request_id: String) -> Result<(), String> {
    let mut inflight = state.inflight.lock();
    if let Some(tx) = inflight.remove(&request_id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{build_claude_argv, ClaudeSendArgs};

    fn sample_args() -> ClaudeSendArgs {
        ClaudeSendArgs {
            request_id: "req-1".into(),
            prompt: "hello".into(),
            cwd: "/tmp".into(),
            resume_session_id: None,
            claude_bin: None,
            skip_permissions: false,
            permission_mode: None,
            model: None,
            system_prompt: None,
            append_system_prompt: None,
            effort: None,
            extra_dirs: vec![],
        }
    }

    fn argv_strings(args: &ClaudeSendArgs) -> Vec<String> {
        build_claude_argv(args, Path::new("/usr/local/bin/claude"))
            .into_iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn build_claude_argv_omits_add_dir_when_extra_dirs_empty() {
        let argv = argv_strings(&sample_args());
        assert!(!argv.iter().any(|arg| arg == "--add-dir"));
    }

    #[test]
    fn build_claude_argv_keeps_non_blank_extra_dirs_in_order() {
        let mut args = sample_args();
        args.extra_dirs = vec!["/a".into(), "  ".into(), "/b".into()];

        let argv = argv_strings(&args);
        let add_dir_idx = argv.iter().position(|arg| arg == "--add-dir").unwrap();

        assert_eq!(
            argv[add_dir_idx..add_dir_idx + 4].to_vec(),
            vec![
                "--add-dir".to_string(),
                "/a".to_string(),
                "--add-dir".to_string(),
                "/b".to_string(),
            ]
        );
        assert_eq!(argv.iter().filter(|arg| *arg == "--add-dir").count(), 2);
    }

    #[test]
    fn build_claude_argv_places_add_dir_after_resume_before_prompt() {
        let mut args = sample_args();
        args.resume_session_id = Some("sess-1".into());
        args.model = Some("sonnet".into());
        args.extra_dirs = vec!["/a".into()];

        let argv = argv_strings(&args);
        let resume_idx = argv.iter().position(|arg| arg == "--resume").unwrap();
        let add_dir_idx = argv.iter().position(|arg| arg == "--add-dir").unwrap();
        let prompt_idx = argv.iter().position(|arg| arg == "hello").unwrap();

        assert!(add_dir_idx > resume_idx);
        assert!(add_dir_idx < prompt_idx);
    }
}
