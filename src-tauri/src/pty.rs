use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;

use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: Option<i32>,
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

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.as_ref() {
        cmd.cwd(dir);
    } else if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", augmented_path());
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", lang);
    } else {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();

    {
        let mut sessions = state.sessions.lock();
        sessions.insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let id_for_thread = id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_handle.emit(
                        "pty:data",
                        PtyDataPayload {
                            id: id_for_thread.clone(),
                            data: encoded,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(
            "pty:exit",
            PtyExitPayload {
                id: id_for_thread.clone(),
                code: None,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut sessions = state.sessions.lock();
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session.writer.write_all(&bytes).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock();
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Vec<String> {
    state.sessions.lock().keys().cloned().collect()
}

#[tauri::command]
pub fn resolve_claude_bin() -> Option<String> {
    let path = augmented_path();
    for dir in path.split(':') {
        let candidate = std::path::Path::new(dir).join("claude");
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}
