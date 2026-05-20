use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: Option<String>,
    pub first_prompt: Option<String>,
    pub last_activity: Option<String>,
    pub mtime_ms: u64,
    pub message_count: usize,
    pub file_path: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub folder: String,
    pub session_count: usize,
    pub last_activity_ms: u64,
}

fn projects_root() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".claude");
        p.push("projects");
        p
    })
}

fn folder_to_path(folder: &str) -> String {
    if folder.starts_with('-') {
        format!("/{}", folder.trim_start_matches('-').replace('-', "/"))
    } else {
        folder.replace('-', "/")
    }
}

fn read_cwd_from_dir(dir: &Path) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    let mut jsonls: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .collect();
    // Prefer the most recently modified file
    jsonls.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0)
    });
    jsonls.reverse();
    for entry in jsonls {
        let Ok(file) = fs::File::open(entry.path()) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().flatten().take(50) {
            if line.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    return Some(c.to_string());
                }
            }
        }
    }
    None
}

fn folder_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn extract_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.get("text").and_then(|v| v.as_str()) {
                    return Some(s.to_string());
                }
            }
            None
        }
        _ => None,
    }
}

fn is_skippable_prompt(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<local-command-caveat>")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<system-reminder>")
}

fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

fn scan_session_file(path: &Path) -> Option<SessionInfo> {
    let id = path.file_stem()?.to_str()?.to_string();
    let metadata = fs::metadata(path).ok()?;
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut cwd: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut last_activity: Option<String> = None;
    let mut message_count = 0usize;

    for line in reader.lines().flatten() {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
        }

        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
            last_activity = Some(ts.to_string());
        }

        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let is_meta = v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false);
        if (ty == "user" || ty == "assistant") && !is_meta {
            message_count += 1;
        }

        if first_prompt.is_none() && ty == "user" {
            if !is_meta {
                if let Some(text) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(extract_text)
                {
                    if !is_skippable_prompt(&text) {
                        first_prompt = Some(truncate(text.trim(), 100));
                    }
                }
            }
        }
    }

    // Apply user-customized title override if present
    let titles = read_titles_map();
    let file_path_str = path.to_string_lossy().to_string();
    if let Some(custom) = titles.get(&file_path_str) {
        first_prompt = Some(custom.clone());
    }

    Some(SessionInfo {
        id,
        cwd,
        first_prompt,
        last_activity,
        mtime_ms,
        message_count,
        file_path: file_path_str,
    })
}

#[tauri::command]
pub fn list_projects() -> Vec<ProjectInfo> {
    let Some(root) = projects_root() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return vec![];
    };

    let mut projects: Vec<ProjectInfo> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().to_string();
            let mut session_count = 0usize;
            let mut last_activity_ms: u64 = 0;
            if let Ok(files) = fs::read_dir(e.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                        session_count += 1;
                        if let Ok(meta) = f.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
                                    let ms = d.as_millis() as u64;
                                    if ms > last_activity_ms {
                                        last_activity_ms = ms;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if session_count == 0 {
                return None;
            }
            // Prefer cwd recorded inside the JSONL (authoritative);
            // fall back to dash-decoded folder name.
            let path = read_cwd_from_dir(&e.path()).unwrap_or_else(|| folder_to_path(&folder));
            let name = folder_label(&path);
            Some(ProjectInfo {
                name,
                path,
                folder,
                session_count,
                last_activity_ms,
            })
        })
        .collect();

    projects.sort_by(|a, b| b.last_activity_ms.cmp(&a.last_activity_ms));
    projects
}

#[tauri::command]
pub fn list_sessions(folder: String, limit: Option<usize>) -> Vec<SessionInfo> {
    let Some(root) = projects_root() else {
        return vec![];
    };
    let dir = root.join(&folder);
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };

    let mut sessions: Vec<SessionInfo> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .filter_map(|e| scan_session_file(&e.path()))
        .filter(|s| s.message_count > 0)
        .collect();

    sessions.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    if let Some(n) = limit {
        sessions.truncate(n);
    }
    sessions
}

#[derive(Clone, Serialize)]
pub struct ReplayMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub tool_name: Option<String>,
    pub is_meta: bool,
}

#[derive(Clone, Serialize)]
pub struct ReplayResult {
    pub session_id: Option<String>,
    pub messages: Vec<ReplayMessage>,
    pub cwd: Option<String>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub context_window: u64,
    pub turn_count: u32,
    pub last_input_tokens: u64,
    pub last_output_tokens: u64,
    pub last_cache_read_tokens: u64,
    pub last_cache_creation_tokens: u64,
}

#[derive(Clone, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub file_path: String,
    pub project_folder: String,
    pub project_path: String,
    pub project_name: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<String>,
    pub mtime_ms: u64,
    pub uuid: Option<String>,
}

#[tauri::command]
pub fn search_sessions(query: String, limit: Option<usize>) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let cap = limit.unwrap_or(50);
    let Some(root) = projects_root() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return vec![];
    };

    let mut hits: Vec<SearchHit> = Vec::new();

    for project_entry in entries.flatten() {
        if !project_entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let folder = project_entry.file_name().to_string_lossy().to_string();
        let project_path = folder_to_path(&folder);
        let project_name = folder_label(&project_path);

        let Ok(files) = fs::read_dir(project_entry.path()) else {
            continue;
        };

        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime_ms = file_entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let Ok(file) = fs::File::open(&path) else {
                continue;
            };
            let session_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let reader = BufReader::new(file);

            for line in reader.lines().flatten() {
                if line.is_empty() || !line.to_lowercase().contains(&q) {
                    continue;
                }
                let v: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if ty != "user" && ty != "assistant" {
                    continue;
                }
                let is_meta = v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false);
                if is_meta {
                    continue;
                }
                let text = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(extract_text)
                    .unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                if is_skippable_prompt(&text) {
                    continue;
                }
                if !text.to_lowercase().contains(&q) {
                    continue;
                }
                let snippet = build_snippet(&text, &q);
                let timestamp = v
                    .get("timestamp")
                    .and_then(|x| x.as_str())
                    .map(String::from);
                let uuid = v.get("uuid").and_then(|x| x.as_str()).map(String::from);
                hits.push(SearchHit {
                    session_id: session_id.clone(),
                    file_path: path.to_string_lossy().to_string(),
                    project_folder: folder.clone(),
                    project_path: project_path.clone(),
                    project_name: project_name.clone(),
                    role: ty.to_string(),
                    snippet,
                    timestamp,
                    mtime_ms,
                    uuid,
                });
                if hits.len() >= cap {
                    hits.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
                    return hits;
                }
            }
        }
    }

    hits.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    hits
}

#[tauri::command]
pub fn search_files(
    cwd: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FileHit>, String> {
    use std::collections::VecDeque;
    let root = std::path::PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", cwd));
    }
    let q = query.trim().to_lowercase();
    let cap = limit.unwrap_or(40);
    let max_visit = 5000usize;
    let skip_dirs: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        ".venv",
        "venv",
        ".DS_Store",
    ];

    let mut hits: Vec<FileHit> = Vec::new();
    let mut queue: VecDeque<std::path::PathBuf> = VecDeque::new();
    queue.push_back(root.clone());
    let mut visited = 0usize;

    while let Some(dir) = queue.pop_front() {
        if visited >= max_visit {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= max_visit {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            if skip_dirs.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                queue.push_back(path);
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string());
            if q.is_empty() || rel.to_lowercase().contains(&q) {
                hits.push(FileHit {
                    rel_path: rel,
                    abs_path: path.to_string_lossy().to_string(),
                });
                if hits.len() >= cap * 2 {
                    break;
                }
            }
        }
    }

    // Rank: exact filename match > basename starts with q > contains q (path)
    let qlc = q.clone();
    hits.sort_by(|a, b| {
        let ascore = score(&a.rel_path, &qlc);
        let bscore = score(&b.rel_path, &qlc);
        ascore.cmp(&bscore).then(a.rel_path.cmp(&b.rel_path))
    });
    hits.truncate(cap);
    Ok(hits)
}

#[derive(Clone, Serialize)]
pub struct FileHit {
    pub rel_path: String,
    pub abs_path: String,
}

fn score(path: &str, q: &str) -> u32 {
    if q.is_empty() {
        return 100;
    }
    let lower = path.to_lowercase();
    let basename = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    if basename == q {
        return 0;
    }
    if basename.starts_with(q) {
        return 1;
    }
    if basename.contains(q) {
        return 2;
    }
    if lower.starts_with(q) {
        return 3;
    }
    if lower.contains(q) {
        return 4;
    }
    99
}

fn build_snippet(text: &str, q: &str) -> String {
    let lower = text.to_lowercase();
    let idx = lower.find(q).unwrap_or(0);
    let chars: Vec<char> = text.chars().collect();
    let byte_to_char = |b: usize| {
        text.char_indices()
            .position(|(off, _)| off >= b)
            .unwrap_or(chars.len())
    };
    let center = byte_to_char(idx);
    let radius = 60usize;
    let start = center.saturating_sub(radius);
    let end = (center + radius + q.chars().count()).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push('…');
    }
    out.replace('\n', " ").replace('\r', " ").trim().to_string()
}

#[tauri::command]
pub fn replay_session(file_path: String) -> Result<ReplayResult, String> {
    let path = std::path::Path::new(&file_path);
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut messages: Vec<ReplayMessage> = Vec::new();
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_create: u64 = 0;
    let mut context_window: u64 = 0;
    let mut turn_count: u32 = 0;
    let mut last_input: u64 = 0;
    let mut last_output: u64 = 0;
    let mut last_cache_read: u64 = 0;
    let mut last_cache_create: u64 = 0;

    for line in reader.lines().flatten() {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if session_id.is_none() {
            if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                session_id = Some(s.to_string());
            }
        }
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
        }

        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

        // Capture usage on assistant lines for cumulative stats
        if ty == "assistant" {
            if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
                let inp = usage
                    .get("input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let out = usage
                    .get("output_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let cr = usage
                    .get("cache_read_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let cc = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                if inp + out + cr + cc > 0 {
                    total_input += inp;
                    total_output += out;
                    total_cache_read += cr;
                    total_cache_create += cc;
                    last_input = inp;
                    last_output = out;
                    last_cache_read = cr;
                    last_cache_create = cc;
                    turn_count += 1;
                }
            }
            if context_window == 0 {
                if let Some(model) = v
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|x| x.as_str())
                {
                    context_window = guess_context_window(model);
                }
            }
        }

        if ty != "user" && ty != "assistant" {
            continue;
        }
        let is_meta = v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false);
        let timestamp = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(String::from);
        let uuid = v
            .get("uuid")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("msg-{}", messages.len()));
        let content = v.get("message").and_then(|m| m.get("content"));
        let mut text = String::new();
        let mut tool_name: Option<String> = None;
        if let Some(content) = content {
            match content {
                Value::String(s) => text.push_str(s),
                Value::Array(items) => {
                    for item in items {
                        let item_ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        match item_ty {
                            "text" => {
                                if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(t);
                                }
                            }
                            "tool_use" => {
                                tool_name =
                                    item.get("name").and_then(|x| x.as_str()).map(String::from);
                            }
                            "tool_result" => {
                                if let Some(t) = item.get("content") {
                                    if let Some(s) = t.as_str() {
                                        if !text.is_empty() {
                                            text.push('\n');
                                        }
                                        text.push_str(s);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }

        if text.is_empty() && tool_name.is_none() {
            continue;
        }

        messages.push(ReplayMessage {
            id: uuid,
            role: ty.to_string(),
            text,
            timestamp,
            tool_name,
            is_meta,
        });
    }

    Ok(ReplayResult {
        session_id,
        messages,
        cwd,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_cache_read,
        total_cache_creation_tokens: total_cache_create,
        context_window,
        turn_count,
        last_input_tokens: last_input,
        last_output_tokens: last_output,
        last_cache_read_tokens: last_cache_read,
        last_cache_creation_tokens: last_cache_create,
    })
}

fn guess_context_window(model: &str) -> u64 {
    let m = model.to_lowercase();
    if m.contains("[1m]") || m.contains("-1m") {
        return 1_000_000;
    }
    if m.contains("haiku") {
        return 200_000;
    }
    if m.contains("opus") || m.contains("sonnet") {
        return 200_000;
    }
    0
}

// ===== Session management =====

fn titles_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("claude-deck-titles.json"),
    )
}

fn read_titles_map() -> std::collections::BTreeMap<String, String> {
    let Some(p) = titles_path() else {
        return Default::default();
    };
    let Ok(content) = fs::read_to_string(&p) else {
        return Default::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn write_titles_map(map: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let Some(p) = titles_path() else {
        return Err("HOME not set".into());
    };
    let parent = p.parent().ok_or("no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(&p, pretty).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_session_titles() -> std::collections::BTreeMap<String, String> {
    read_titles_map()
}

#[tauri::command]
pub fn rename_session(file_path: String, new_title: String) -> Result<(), String> {
    let mut map = read_titles_map();
    let trimmed = new_title.trim();
    if trimmed.is_empty() {
        map.remove(&file_path);
    } else {
        map.insert(file_path, trimmed.to_string());
    }
    write_titles_map(&map)
}

fn archive_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".claude")
        .join("claude-deck-archive");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn archive_session(file_path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&file_path);
    if !src.is_file() {
        return Err(format!("not a file: {}", file_path));
    }
    let archive = archive_dir()?;
    let folder = src
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());
    let target_dir = archive.join(&folder);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let filename = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "session.jsonl".into());
    let target = target_dir.join(filename);
    fs::rename(&src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_session(file_path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&file_path);
    if !p.is_file() {
        return Err(format!("not a file: {}", file_path));
    }
    // Also drop any custom title for this session
    let mut map = read_titles_map();
    if map.remove(&file_path).is_some() {
        let _ = write_titles_map(&map);
    }
    fs::remove_file(&p).map_err(|e| e.to_string())
}
