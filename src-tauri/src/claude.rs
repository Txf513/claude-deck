use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct ClaudeState {
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Clone, Serialize)]
struct ClaudeEventPayload {
    request_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ClaudeStderrPayload {
    request_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ClaudeDonePayload {
    request_id: String,
    code: Option<i32>,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct ClaudeSendArgs {
    pub request_id: String,
    pub prompt: String,
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub claude_bin: Option<String>,
    #[serde(default)]
    pub skip_permissions: bool,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
}

fn augmented_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let mut extras = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if !home.is_empty() {
        extras.push(format!("{}/.cargo/bin", home));
        if let Ok(entries) = std::fs::read_dir(format!("{}/.nvm/versions/node", home)) {
            let mut versions: Vec<_> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                extras.push(format!("{}/bin", latest.display()));
            }
        }
    }
    let mut parts: Vec<&str> = existing.split(':').filter(|s| !s.is_empty()).collect();
    for extra in &extras {
        if !parts.iter().any(|p| *p == extra.as_str()) {
            parts.push(extra.as_str());
        }
    }
    parts.join(":")
}

fn resolve_bin(explicit: Option<String>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    for dir in augmented_path().split(':') {
        let candidate = PathBuf::from(dir).join("claude");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    args: ClaudeSendArgs,
) -> Result<(), String> {
    let bin = resolve_bin(args.claude_bin).ok_or("claude binary not found")?;

    if !std::path::Path::new(&args.cwd).is_dir() {
        return Err(format!(
            "工作目录不存在: {}（项目路径解析有误，请到该项目重新打开历史会话）",
            args.cwd
        ));
    }

    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg(&args.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");
    if args.skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    } else if let Some(mode) = args.permission_mode.as_deref() {
        if !mode.is_empty() && mode != "default" {
            cmd.arg("--permission-mode").arg(mode);
        }
    }
    if let Some(model) = args.model.as_deref() {
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
    }
    if let Some(sid) = args.resume_session_id.as_ref() {
        cmd.arg("--resume").arg(sid);
    }
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
            let _ = app_for_stdout.emit(
                "claude:event",
                ClaudeEventPayload {
                    request_id: req_id_stdout.clone(),
                    line,
                },
            );
        }
    });

    let app_for_stderr = app.clone();
    let req_id_stderr = args.request_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "claude:stderr",
                ClaudeStderrPayload {
                    request_id: req_id_stderr.clone(),
                    line,
                },
            );
        }
    });

    let req_id_for_done = args.request_id.clone();
    let app_for_done = app.clone();
    let state_inflight = state.inflight.lock().keys().cloned().collect::<Vec<_>>();
    drop(state_inflight);
    let cleanup_handle = state.inner() as *const ClaudeState;
    let cleanup_handle = unsafe { &*cleanup_handle };

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
        cleanup_handle.inflight.lock().remove(&req_id_for_done);
        let _ = app_for_done.emit(
            "claude:done",
            ClaudeDonePayload {
                request_id: req_id_for_done,
                code,
                error: err,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn claude_cancel(state: State<'_, ClaudeState>, request_id: String) -> Result<(), String> {
    let mut inflight = state.inflight.lock();
    if let Some(tx) = inflight.remove(&request_id) {
        let _ = tx.send(());
    }
    Ok(())
}
