use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use specta_typescript::Number;
use tar::{Archive, Builder, EntryType};

#[derive(Clone, Serialize, Type)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: Option<String>,
    pub first_prompt: Option<String>,
    pub last_activity: Option<String>,
    #[specta(type = Number<u64>)]
    pub mtime_ms: u64,
    #[specta(type = Number<usize>)]
    pub message_count: usize,
    pub file_path: String,
}

#[derive(Clone, Serialize, Type)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub folder: String,
    #[specta(type = Number<usize>)]
    pub session_count: usize,
    #[specta(type = Number<u64>)]
    pub last_activity_ms: u64,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ExportResult {
    pub path: String,
    #[specta(type = Number<u32>)]
    pub project_count: u32,
    #[specta(type = Number<u32>)]
    pub session_count: u32,
    #[specta(type = Number<u64>)]
    pub byte_size: u64,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ImportResult {
    #[specta(type = Number<u32>)]
    pub project_count: u32,
    #[specta(type = Number<u32>)]
    pub imported_session_count: u32,
    #[specta(type = Number<u32>)]
    pub skipped_session_count: u32,
    #[specta(type = Number<u32>)]
    pub titles_added: u32,
    #[specta(type = Number<u32>)]
    pub titles_kept: u32,
    pub source_path: String,
}

enum SafeArchiveEntry {
    Session {
        folder: String,
        file_name: String,
        contents: Vec<u8>,
    },
    Titles {
        contents: Vec<u8>,
    },
}

fn projects_root() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".claude");
        p.push("projects");
        p
    })
}

fn claude_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
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
        for line in reader.lines().map_while(Result::ok).take(50) {
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

// Count "atomic" message units inside a single user/assistant JSONL line.
// A plain text message counts as 1; a content array contributes one unit per
// text / tool_use / tool_result block. Other block types (e.g. thinking,
// image-only carriers) are ignored. An empty/missing content also counts as 1
// so legacy lines without structured content still register.
fn count_message_blocks(content: Option<&Value>) -> usize {
    match content {
        Some(Value::Array(items)) => {
            let mut n = 0usize;
            for item in items {
                let ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if matches!(ty, "text" | "tool_use" | "tool_result") {
                    n += 1;
                }
            }
            if n == 0 {
                1
            } else {
                n
            }
        }
        _ => 1,
    }
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

    for line in reader.lines().map_while(Result::ok) {
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
            let content = v.get("message").and_then(|m| m.get("content"));
            message_count += count_message_blocks(content);
        }

        if first_prompt.is_none() && ty == "user" && !is_meta {
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
#[specta::specta]
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

    projects.sort_by_key(|p| std::cmp::Reverse(p.last_activity_ms));
    projects
}

#[tauri::command]
#[specta::specta]
pub fn list_sessions(folder: String, limit: Option<u32>) -> Vec<SessionInfo> {
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

    sessions.sort_by_key(|s| std::cmp::Reverse(s.mtime_ms));
    if let Some(n) = limit {
        sessions.truncate(n as usize);
    }
    sessions
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ReplayMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub tool_name: Option<String>,
    pub is_meta: bool,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ReplayEntry {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub tool_input_json: Option<String>,
    pub tool_output_text: Option<String>,
    pub is_error: bool,
    pub is_meta: bool,
}

#[derive(Clone, Serialize, Type)]
pub struct ReplayResult {
    pub session_id: Option<String>,
    pub messages: Vec<ReplayMessage>,
    pub entries: Vec<ReplayEntry>,
    pub cwd: Option<String>,
    #[specta(type = Number<u64>)]
    pub total_input_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_output_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_cache_read_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_cache_creation_tokens: u64,
    #[specta(type = Number<u64>)]
    pub context_window: u64,
    pub turn_count: u32,
    #[specta(type = Number<u64>)]
    pub last_input_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_output_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_cache_read_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_cache_creation_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ReplayPage {
    pub session_id: Option<String>,
    pub messages: Vec<ReplayMessage>,
    pub entries: Vec<ReplayEntry>,
    pub cwd: Option<String>,
    #[specta(type = Number<u64>)]
    pub total_input_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_output_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_cache_read_tokens: u64,
    #[specta(type = Number<u64>)]
    pub total_cache_creation_tokens: u64,
    #[specta(type = Number<u64>)]
    pub context_window: u64,
    pub turn_count: u32,
    #[specta(type = Number<u64>)]
    pub last_input_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_output_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_cache_read_tokens: u64,
    #[specta(type = Number<u64>)]
    pub last_cache_creation_tokens: u64,
    pub total_message_count: u32,
    pub returned_message_count: u32,
    pub has_more_before: bool,
    pub earliest_uuid: Option<String>,
}

#[derive(Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPageQuery {
    pub limit: Option<u32>,
    pub before_uuid: Option<String>,
}

enum ReplayFilter {
    All,
    Tail { limit: usize },
    Before { uuid: String, limit: usize },
}

struct LineSnapshot {
    uuid: String,
    content: Value,
    timestamp: Option<String>,
    is_meta: bool,
    ty: String,
}

struct ReplayCollected {
    session_id: Option<String>,
    messages: Vec<ReplayMessage>,
    entries: Vec<ReplayEntry>,
    cwd: Option<String>,
    total_input_tokens: u64,
    total_output_tokens: u64,
    total_cache_read_tokens: u64,
    total_cache_creation_tokens: u64,
    context_window: u64,
    turn_count: u32,
    last_input_tokens: u64,
    last_output_tokens: u64,
    last_cache_read_tokens: u64,
    last_cache_creation_tokens: u64,
    total_message_count: u32,
    returned_message_count: u32,
    has_more_before: bool,
    earliest_uuid: Option<String>,
}

#[derive(Clone, Serialize, Type)]
pub struct SearchHit {
    pub session_id: String,
    pub file_path: String,
    pub project_folder: String,
    pub project_path: String,
    pub project_name: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<String>,
    #[specta(type = Number<u64>)]
    pub mtime_ms: u64,
    pub uuid: Option<String>,
    pub entry_kind: Option<String>,
    pub tool_name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn search_sessions(query: String, limit: Option<u32>) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let cap = limit.unwrap_or(50) as usize;
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

            for line in reader.lines().map_while(Result::ok) {
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
                let (text, tool_name, entry_kind) =
                    extract_search_content(v.get("message").and_then(|m| m.get("content")));
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
                    entry_kind,
                    tool_name,
                });
                if hits.len() >= cap {
                    hits.sort_by_key(|h| std::cmp::Reverse(h.mtime_ms));
                    return hits;
                }
            }
        }
    }

    hits.sort_by_key(|h| std::cmp::Reverse(h.mtime_ms));
    hits
}

#[tauri::command]
#[specta::specta]
pub fn search_files(
    cwd: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FileHit>, String> {
    use std::collections::VecDeque;
    let root = std::path::PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", cwd));
    }
    let q = query.trim().to_lowercase();
    let cap = limit.unwrap_or(40) as usize;
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

#[derive(Clone, Serialize, Type)]
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
    out.replace(['\n', '\r'], " ").trim().to_string()
}

fn extract_search_content(content: Option<&Value>) -> (String, Option<String>, Option<String>) {
    let Some(content) = content else {
        return (String::new(), None, None);
    };
    match content {
        Value::String(s) => (s.clone(), None, Some("text".into())),
        Value::Array(items) => {
            let mut text = String::new();
            let mut tool_name: Option<String> = None;
            let mut entry_kind: Option<String> = None;
            for item in items {
                let item_ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match item_ty {
                    "text" => {
                        if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                            entry_kind.get_or_insert_with(|| "text".into());
                        }
                    }
                    "tool_use" => {
                        tool_name = item.get("name").and_then(|x| x.as_str()).map(String::from);
                        entry_kind = Some("tool_call".into());
                    }
                    "tool_result" => {
                        if let Some(s) = tool_result_text(item.get("content")) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&s);
                        }
                        if entry_kind.is_none() {
                            entry_kind = Some("tool_result".into());
                        }
                    }
                    _ => {}
                }
            }
            (text, tool_name, entry_kind)
        }
        _ => (String::new(), None, None),
    }
}

fn tool_result_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => {
            let mut out = String::new();
            for item in items {
                if let Some(s) = item.as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(s);
                    continue;
                }
                if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn replay_entries_from_content(
    role: &str,
    base_id: &str,
    timestamp: Option<String>,
    content: Option<&Value>,
    is_meta: bool,
) -> (String, Option<String>, Vec<ReplayEntry>) {
    let Some(content) = content else {
        return (String::new(), None, vec![]);
    };
    match content {
        Value::String(s) => (
            s.clone(),
            None,
            vec![ReplayEntry {
                id: base_id.to_string(),
                kind: "text".into(),
                role: role.to_string(),
                text: s.clone(),
                timestamp,
                tool_name: None,
                tool_use_id: None,
                tool_input_json: None,
                tool_output_text: None,
                is_error: false,
                is_meta,
            }],
        ),
        Value::Array(items) => {
            let mut text = String::new();
            let mut tool_name: Option<String> = None;
            let mut entries = Vec::new();
            let mut idx = 0usize;
            for item in items {
                let item_ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match item_ty {
                    "text" => {
                        if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                            entries.push(ReplayEntry {
                                id: format!("{base_id}-text-{idx}"),
                                kind: "text".into(),
                                role: role.to_string(),
                                text: t.to_string(),
                                timestamp: timestamp.clone(),
                                tool_name: None,
                                tool_use_id: None,
                                tool_input_json: None,
                                tool_output_text: None,
                                is_error: false,
                                is_meta,
                            });
                            idx += 1;
                        }
                    }
                    "tool_use" => {
                        tool_name = item.get("name").and_then(|x| x.as_str()).map(String::from);
                        entries.push(ReplayEntry {
                            id: format!("{base_id}-tool-call-{idx}"),
                            kind: "tool_call".into(),
                            role: "tool".into(),
                            text: String::new(),
                            timestamp: timestamp.clone(),
                            tool_name: tool_name.clone(),
                            tool_use_id: item.get("id").and_then(|x| x.as_str()).map(String::from),
                            tool_input_json: item
                                .get("input")
                                .and_then(|x| serde_json::to_string(x).ok()),
                            tool_output_text: None,
                            is_error: false,
                            is_meta,
                        });
                        idx += 1;
                    }
                    "tool_result" => {
                        let output = tool_result_text(item.get("content")).unwrap_or_default();
                        if !output.is_empty() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&output);
                        }
                        entries.push(ReplayEntry {
                            id: format!("{base_id}-tool-result-{idx}"),
                            kind: "tool_result".into(),
                            role: "tool".into(),
                            text: output.clone(),
                            timestamp: timestamp.clone(),
                            tool_name: None,
                            tool_use_id: item
                                .get("tool_use_id")
                                .and_then(|x| x.as_str())
                                .map(String::from),
                            tool_input_json: None,
                            tool_output_text: if output.is_empty() {
                                None
                            } else {
                                Some(output)
                            },
                            is_error: item
                                .get("is_error")
                                .and_then(|x| x.as_bool())
                                .unwrap_or(false),
                            is_meta,
                        });
                        idx += 1;
                    }
                    _ => {}
                }
            }
            (text, tool_name, entries)
        }
        _ => (String::new(), None, vec![]),
    }
}

fn replay_message_preview(
    role: &str,
    content: Option<&Value>,
    is_meta: bool,
) -> (String, Option<String>) {
    let (text, tool_name, _) = replay_entries_from_content(role, "", None, content, is_meta);
    (text, tool_name)
}

fn replay_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(600).min(5000) as usize
}

fn replay_materialize(snapshots: &[LineSnapshot]) -> (Vec<ReplayMessage>, Vec<ReplayEntry>) {
    let mut messages: Vec<ReplayMessage> = Vec::with_capacity(snapshots.len());
    let mut entries: Vec<ReplayEntry> = Vec::new();

    for snapshot in snapshots {
        let content = snapshot
            .content
            .get("message")
            .and_then(|m| m.get("content"));
        let (text, tool_name, mut line_entries) = replay_entries_from_content(
            &snapshot.ty,
            &snapshot.uuid,
            snapshot.timestamp.clone(),
            content,
            snapshot.is_meta,
        );

        if text.is_empty() && tool_name.is_none() {
            continue;
        }

        entries.append(&mut line_entries);
        messages.push(ReplayMessage {
            id: snapshot.uuid.clone(),
            role: snapshot.ty.clone(),
            text,
            timestamp: snapshot.timestamp.clone(),
            tool_name,
            is_meta: snapshot.is_meta,
        });
    }

    (messages, entries)
}

fn replay_collect(file_path: &Path, filter: ReplayFilter) -> Result<ReplayCollected, String> {
    let file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut snapshots: Vec<LineSnapshot> = Vec::new();
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

    for line in reader.lines().map_while(Result::ok) {
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

        let ty = v
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();

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
        let content = v.get("message").and_then(|m| m.get("content"));
        let (text, tool_name) = replay_message_preview(&ty, content, is_meta);
        if text.is_empty() && tool_name.is_none() {
            continue;
        }

        let uuid = v
            .get("uuid")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("msg-{}", snapshots.len()));

        snapshots.push(LineSnapshot {
            uuid,
            content: v,
            timestamp,
            is_meta,
            ty,
        });
    }

    let total_message_count = snapshots.len() as u32;
    let (start, end) = match filter {
        ReplayFilter::All => (0usize, snapshots.len()),
        ReplayFilter::Tail { limit } => (snapshots.len().saturating_sub(limit), snapshots.len()),
        ReplayFilter::Before { uuid, limit } => {
            let end = snapshots
                .iter()
                .position(|snapshot| snapshot.uuid == uuid)
                .ok_or_else(|| format!("before_uuid not found: {uuid}"))?;
            (end.saturating_sub(limit), end)
        }
    };
    let page_snapshots = &snapshots[start..end];
    let (messages, entries) = replay_materialize(page_snapshots);

    Ok(ReplayCollected {
        session_id,
        messages,
        entries,
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
        total_message_count,
        returned_message_count: page_snapshots.len() as u32,
        has_more_before: start > 0,
        earliest_uuid: page_snapshots.first().map(|snapshot| snapshot.uuid.clone()),
    })
}

#[tauri::command]
#[specta::specta]
pub fn replay_session(file_path: String) -> Result<ReplayResult, String> {
    let path = std::path::Path::new(&file_path);
    let collected = replay_collect(path, ReplayFilter::All)?;
    Ok(ReplayResult {
        session_id: collected.session_id,
        messages: collected.messages,
        entries: collected.entries,
        cwd: collected.cwd,
        total_input_tokens: collected.total_input_tokens,
        total_output_tokens: collected.total_output_tokens,
        total_cache_read_tokens: collected.total_cache_read_tokens,
        total_cache_creation_tokens: collected.total_cache_creation_tokens,
        context_window: collected.context_window,
        turn_count: collected.turn_count,
        last_input_tokens: collected.last_input_tokens,
        last_output_tokens: collected.last_output_tokens,
        last_cache_read_tokens: collected.last_cache_read_tokens,
        last_cache_creation_tokens: collected.last_cache_creation_tokens,
    })
}

#[tauri::command]
#[specta::specta]
pub fn replay_session_paged(
    file_path: String,
    query: ReplayPageQuery,
) -> Result<ReplayPage, String> {
    let path = std::path::Path::new(&file_path);
    let limit = replay_limit(query.limit);
    let filter = match query.before_uuid {
        Some(uuid) => ReplayFilter::Before { uuid, limit },
        None => ReplayFilter::Tail { limit },
    };
    let collected = replay_collect(path, filter)?;

    Ok(ReplayPage {
        session_id: collected.session_id,
        messages: collected.messages,
        entries: collected.entries,
        cwd: collected.cwd,
        total_input_tokens: collected.total_input_tokens,
        total_output_tokens: collected.total_output_tokens,
        total_cache_read_tokens: collected.total_cache_read_tokens,
        total_cache_creation_tokens: collected.total_cache_creation_tokens,
        context_window: collected.context_window,
        turn_count: collected.turn_count,
        last_input_tokens: collected.last_input_tokens,
        last_output_tokens: collected.last_output_tokens,
        last_cache_read_tokens: collected.last_cache_read_tokens,
        last_cache_creation_tokens: collected.last_cache_creation_tokens,
        total_message_count: collected.total_message_count,
        returned_message_count: collected.returned_message_count,
        has_more_before: collected.has_more_before,
        earliest_uuid: collected.earliest_uuid,
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

fn collect_project_entries(dir: &Path, folder: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        })
        .collect();
    files.sort();
    Ok(files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            Some((path, format!("projects/{folder}/{name}")))
        })
        .collect())
}

fn ensure_export_out_path(out: &Path) -> Result<(), String> {
    let parent = out.parent().unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        return Err(format!(
            "output directory does not exist: {}",
            parent.display()
        ));
    }
    if out.is_dir() {
        return Err("output path is a directory".into());
    }
    Ok(())
}

fn write_tar_gz(out: &Path, entries: &[(PathBuf, &str)]) -> Result<u64, String> {
    ensure_export_out_path(out)?;
    let temp_path = PathBuf::from(format!("{}.part", out.to_string_lossy()));

    let result = (|| -> Result<u64, String> {
        let file = fs::File::create(&temp_path).map_err(|e| e.to_string())?;
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);

        for (source, archive_path) in entries {
            builder
                .append_path_with_name(source, archive_path)
                .map_err(|e| e.to_string())?;
        }

        let encoder = builder.into_inner().map_err(|e| e.to_string())?;
        let file = encoder.finish().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        let byte_size = file.metadata().map_err(|e| e.to_string())?.len();
        drop(file);
        fs::rename(&temp_path, out).map_err(|e| e.to_string())?;
        Ok(byte_size)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

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

fn write_titles_object(map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let Some(p) = titles_path() else {
        return Err("HOME not set".into());
    };
    let parent = p.parent().ok_or("no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let pretty =
        serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|e| e.to_string())?;
    fs::write(&p, pretty).map_err(|e| e.to_string())
}

fn unsafe_archive_entry(path: &Path) -> String {
    format!("archive contains unsafe entry: {}", path.to_string_lossy())
}

fn read_safe_archive(path: &Path) -> Result<Vec<SafeArchiveEntry>, String> {
    let file = fs::File::open(path).map_err(|e| format!("failed to read archive: {e}"))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| format!("failed to read archive: {e}"))?;
    let mut safe_entries = Vec::new();

    for entry_result in entries {
        let mut entry = entry_result.map_err(|e| format!("failed to read archive: {e}"))?;
        let entry_path = entry
            .path()
            .map_err(|e| format!("failed to read archive: {e}"))?
            .into_owned();

        if entry.header().entry_type() != EntryType::Regular || entry_path.is_absolute() {
            return Err(unsafe_archive_entry(&entry_path));
        }
        if entry_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
                    | Component::CurDir
            )
        }) {
            return Err(unsafe_archive_entry(&entry_path));
        }

        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .map_err(|e| format!("failed to read archive: {e}"))?;

        let safe_entry = match entry_path.components().collect::<Vec<_>>().as_slice() {
            [Component::Normal(file_name)]
                if file_name.to_string_lossy() == "claude-deck-titles.json" =>
            {
                SafeArchiveEntry::Titles { contents }
            }
            [Component::Normal(root), Component::Normal(folder), Component::Normal(file_name)]
                if root.to_string_lossy() == "projects"
                    && file_name.to_string_lossy().ends_with(".jsonl") =>
            {
                SafeArchiveEntry::Session {
                    folder: folder.to_string_lossy().to_string(),
                    file_name: file_name.to_string_lossy().to_string(),
                    contents,
                }
            }
            _ => return Err(unsafe_archive_entry(&entry_path)),
        };

        safe_entries.push(safe_entry);
    }

    Ok(safe_entries)
}

#[tauri::command]
#[specta::specta]
pub fn read_session_titles() -> std::collections::BTreeMap<String, String> {
    read_titles_map()
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
pub fn export_all_projects(out_path: String) -> Result<ExportResult, String> {
    let projects_dir = claude_root()?.join("projects");
    let mut project_dirs: Vec<_> = fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false))
        .collect();
    project_dirs.sort_by_key(|entry| entry.file_name());

    let mut owned_entries: Vec<(PathBuf, String)> = Vec::new();
    let mut project_count = 0u32;
    let mut session_count = 0u32;

    for project_dir in project_dirs {
        let folder = project_dir.file_name().to_string_lossy().to_string();
        let session_entries = collect_project_entries(&project_dir.path(), &folder)?;
        if session_entries.is_empty() {
            continue;
        }
        project_count += 1;
        session_count += session_entries.len() as u32;
        owned_entries.extend(session_entries);
    }

    if let Some(titles) = titles_path() {
        if titles.exists() {
            owned_entries.push((titles, "claude-deck-titles.json".into()));
        }
    }

    let ref_entries: Vec<(PathBuf, &str)> = owned_entries
        .iter()
        .map(|(path, archive_path)| (path.clone(), archive_path.as_str()))
        .collect();
    let out = PathBuf::from(&out_path);
    let byte_size = write_tar_gz(&out, &ref_entries)?;

    Ok(ExportResult {
        path: out.to_string_lossy().to_string(),
        project_count,
        session_count,
        byte_size,
    })
}

#[tauri::command]
#[specta::specta]
pub fn export_project(folder: String, out_path: String) -> Result<ExportResult, String> {
    let dir = claude_root()?.join("projects").join(&folder);
    let mut owned_entries = collect_project_entries(&dir, &folder)?;
    let session_count = owned_entries.len() as u32;
    if session_count == 0 {
        return Err("project has no sessions".into());
    }

    if let Some(titles) = titles_path() {
        if titles.exists() {
            owned_entries.push((titles, "claude-deck-titles.json".into()));
        }
    }

    let ref_entries: Vec<(PathBuf, &str)> = owned_entries
        .iter()
        .map(|(path, archive_path)| (path.clone(), archive_path.as_str()))
        .collect();
    let out = PathBuf::from(&out_path);
    let byte_size = write_tar_gz(&out, &ref_entries)?;

    Ok(ExportResult {
        path: out.to_string_lossy().to_string(),
        project_count: 1,
        session_count,
        byte_size,
    })
}

#[tauri::command]
#[specta::specta]
pub fn import_backup(archive_path: String) -> Result<ImportResult, String> {
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err("archive does not exist".into());
    }
    if archive.is_dir() {
        return Err("archive path is a directory".into());
    }

    let claude_dir = claude_root()?;
    let safe_entries = read_safe_archive(&archive)?;
    let projects_dir = claude_dir.join("projects");
    let mut seen_projects = std::collections::BTreeSet::new();
    let mut imported_session_count = 0u32;
    let mut skipped_session_count = 0u32;
    let mut titles_added = 0u32;
    let mut titles_kept = 0u32;

    for entry in safe_entries {
        match entry {
            SafeArchiveEntry::Session {
                folder,
                file_name,
                contents,
            } => {
                seen_projects.insert(folder.clone());
                let dest = projects_dir.join(&folder).join(&file_name);
                if dest.exists() {
                    skipped_session_count += 1;
                    continue;
                }
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&dest, contents).map_err(|e| e.to_string())?;
                imported_session_count += 1;
            }
            SafeArchiveEntry::Titles { contents } => {
                let backup_map: serde_json::Map<String, Value> =
                    serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
                let titles_file = titles_path().ok_or("HOME not set")?;
                let current_raw = fs::read_to_string(&titles_file).ok();
                let (mut current_map, parsed_current) = match current_raw {
                    Some(raw) => match serde_json::from_str::<serde_json::Map<String, Value>>(&raw)
                    {
                        Ok(map) => (map, true),
                        Err(_) => (serde_json::Map::new(), false),
                    },
                    None => (serde_json::Map::new(), true),
                };

                for (key, value) in backup_map {
                    if let serde_json::map::Entry::Vacant(slot) = current_map.entry(key) {
                        slot.insert(value);
                        titles_added += 1;
                    } else {
                        titles_kept += 1;
                    }
                }

                if parsed_current || !current_map.is_empty() {
                    write_titles_object(&current_map)?;
                }
            }
        }
    }

    Ok(ImportResult {
        project_count: seen_projects.len() as u32,
        imported_session_count,
        skipped_session_count,
        titles_added,
        titles_kept,
        source_path: archive.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use std::fs::File;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, MutexGuard};
    use tar::{Archive, Builder, EntryType, Header};

    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("claude-deck-{}-{}", prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    struct HomeGuard(Option<String>);

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(old_home) = &self.0 {
                std::env::set_var("HOME", old_home);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    fn lock_home(home_dir: &Path) -> (MutexGuard<'static, ()>, HomeGuard) {
        let lock = HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", home_dir);
        (lock, HomeGuard(old_home))
    }

    fn archive_entries(path: &Path) -> Vec<(String, u64)> {
        let file = File::open(path).unwrap();
        let mut archive = Archive::new(GzDecoder::new(file));
        let mut entries = archive
            .entries()
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let size = entry.size();
                let path = entry.path().unwrap().to_string_lossy().to_string();
                (path, size)
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    fn write_custom_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);

        for (archive_path, contents) in entries {
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(contents.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, *archive_path, *contents)
                .unwrap();
        }

        let encoder = builder.into_inner().unwrap();
        let file = encoder.finish().unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn replay_session_preserves_tool_entries() {
        let dir = temp_dir("replay");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/App.tsx\"}}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"file contents\",\"is_error\":false}]}}\n",
            ),
        );

        let replay = replay_session(file_path.to_string_lossy().to_string()).unwrap();
        let value = serde_json::to_value(&replay).unwrap();

        assert!(
            value.get("entries").is_some(),
            "expected structured replay entries in replay result, got {:?}",
            value
                .as_object()
                .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        );
    }

    #[test]
    fn scan_session_counts_tool_use_and_tool_result_blocks() {
        let dir = temp_dir("count");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                // user with plain string content -> 1
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"hi\"}}\n",
                // assistant with text + 2 tool_use blocks -> 3
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"message\":{\"content\":[",
                "{\"type\":\"text\",\"text\":\"reading\"},",
                "{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{}},",
                "{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Grep\",\"input\":{}}",
                "]}}\n",
                // user with two tool_result blocks -> 2
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"content\":[",
                "{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"},",
                "{\"type\":\"tool_result\",\"tool_use_id\":\"t2\",\"content\":\"ok\"}",
                "]}}\n",
                // meta user line -> ignored
                "{\"type\":\"user\",\"uuid\":\"u3\",\"isMeta\":true,\"message\":{\"content\":\"meta\"}}\n",
            ),
        );

        let info = scan_session_file(&file_path).expect("scan should succeed");
        assert_eq!(
            info.message_count, 6,
            "expected 1+3+2 blocks, got {}",
            info.message_count
        );
    }

    #[test]
    fn search_sessions_keeps_tool_context_fields() {
        let home_dir = temp_dir("search-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let project_dir = home_dir
            .join(".claude")
            .join("projects")
            .join("-tmp-project");
        let file_path = project_dir.join("session-1.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"timestamp\":\"2026-05-20T12:00:00Z\",\"message\":{\"content\":[",
                "{\"type\":\"text\",\"text\":\"Read src/App.tsx\"},",
                "{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/App.tsx\"}}",
                "]}}\n",
            ),
        );

        let hits = search_sessions("read".into(), Some(10));
        let value = serde_json::to_value(hits.first().expect("expected at least one hit")).unwrap();

        assert!(
            value.get("entry_kind").is_some(),
            "expected entry_kind in serialized search hit: {value:?}"
        );
        assert!(
            value.get("tool_name").is_some(),
            "expected tool_name in serialized search hit: {value:?}"
        );
    }

    #[test]
    fn export_all_projects_packs_projects_and_titles() {
        let home_dir = temp_dir("export-all-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let claude_dir = home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        write_file(
            &projects_dir.join("p1").join("s1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        );
        write_file(
            &projects_dir.join("p2").join("s2.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"content\":\"world\"}}\n",
        );
        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"a\": \"b\"\n}\n",
        );

        let out_path = home_dir.join("all-backup.tar.gz");
        let result = export_all_projects(out_path.to_string_lossy().to_string()).unwrap();
        let entries = archive_entries(&out_path);

        assert_eq!(
            entries
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>(),
            vec![
                "claude-deck-titles.json".to_string(),
                "projects/p1/s1.jsonl".to_string(),
                "projects/p2/s2.jsonl".to_string(),
            ]
        );
        assert_eq!(result.project_count, 2);
        assert_eq!(result.session_count, 2);
        assert!(result.byte_size > 0);
    }

    #[test]
    fn export_project_handles_success_missing_and_empty_cases() {
        let home_dir = temp_dir("export-project-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let claude_dir = home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        write_file(
            &projects_dir.join("target-folder").join("session-1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        );
        write_file(
            &projects_dir.join("other-folder").join("session-2.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"content\":\"world\"}}\n",
        );
        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"x\": \"y\"\n}\n",
        );
        fs::create_dir_all(projects_dir.join("empty-folder")).unwrap();

        let out_path = home_dir.join("project-backup.tar.gz");
        let result = export_project(
            "target-folder".into(),
            out_path.to_string_lossy().to_string(),
        )
        .unwrap();
        let entries = archive_entries(&out_path);

        let missing_err = export_project(
            "missing-folder".into(),
            home_dir
                .join("missing.tar.gz")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap_err();
        let empty_err = export_project(
            "empty-folder".into(),
            home_dir.join("empty.tar.gz").to_string_lossy().to_string(),
        )
        .unwrap_err();

        assert_eq!(
            entries
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>(),
            vec![
                "claude-deck-titles.json".to_string(),
                "projects/target-folder/session-1.jsonl".to_string(),
            ]
        );
        assert_eq!(result.project_count, 1);
        assert_eq!(result.session_count, 1);
        assert!(missing_err.contains("No such file or directory"));
        assert_eq!(empty_err, "project has no sessions");
    }

    #[test]
    fn export_commands_validate_output_path_and_cleanup_part_files() {
        let home_dir = temp_dir("export-errors-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let claude_dir = home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        write_file(
            &projects_dir.join("p1").join("s1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        );

        let missing_parent = home_dir.join("missing-parent").join("backup.tar.gz");
        let missing_parent_err =
            export_all_projects(missing_parent.to_string_lossy().to_string()).unwrap_err();

        let out_dir = home_dir.join("backup-dir");
        fs::create_dir_all(&out_dir).unwrap();
        let dir_err = export_all_projects(out_dir.to_string_lossy().to_string()).unwrap_err();

        let titles_file = claude_dir.join("claude-deck-titles.json");
        write_file(&titles_file, "{\n  \"locked\": true\n}\n");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&titles_file).unwrap().permissions();
            permissions.set_mode(0o000);
            fs::set_permissions(&titles_file, permissions).unwrap();
        }
        let failing_out = home_dir.join("failing-backup.tar.gz");
        let failing_err =
            export_all_projects(failing_out.to_string_lossy().to_string()).unwrap_err();
        let part_path = PathBuf::from(format!("{}.part", failing_out.to_string_lossy()));

        assert_eq!(
            missing_parent_err,
            format!(
                "output directory does not exist: {}",
                missing_parent.parent().unwrap().display()
            )
        );
        assert_eq!(dir_err, "output path is a directory");
        assert!(
            failing_err.contains("Permission denied") || failing_err.contains("permission denied")
        );
        assert!(
            !part_path.exists(),
            "temporary part file should be cleaned up"
        );
    }

    #[test]
    fn import_backup_writes_new_sessions_and_skips_existing() {
        let home_dir = temp_dir("import-backup-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let claude_dir = home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        write_file(
            &projects_dir.join("p1").join("s1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        );
        write_file(
            &projects_dir.join("p2").join("s2.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"content\":\"world\"}}\n",
        );

        let out_path = home_dir.join("import-source.tar.gz");
        let exported = export_all_projects(out_path.to_string_lossy().to_string()).unwrap();
        fs::remove_dir_all(&projects_dir).unwrap();

        let first = import_backup(out_path.to_string_lossy().to_string()).unwrap();
        let second = import_backup(out_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(first.project_count, 2);
        assert_eq!(first.imported_session_count, exported.session_count);
        assert_eq!(first.skipped_session_count, 0);
        assert!(projects_dir.join("p1").join("s1.jsonl").is_file());
        assert!(projects_dir.join("p2").join("s2.jsonl").is_file());

        assert_eq!(second.project_count, 2);
        assert_eq!(second.imported_session_count, 0);
        assert_eq!(second.skipped_session_count, exported.session_count);
    }

    #[test]
    fn import_backup_merges_titles_without_overwriting() {
        let home_dir = temp_dir("import-titles-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let claude_dir = home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        write_file(
            &projects_dir.join("p1").join("s1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        );

        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"k1\": \"old\"\n}\n",
        );
        let archive_a = home_dir.join("titles-a.tar.gz");
        export_all_projects(archive_a.to_string_lossy().to_string()).unwrap();

        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"k1\": \"current\",\n  \"k2\": \"已有\"\n}\n",
        );
        let result_a = import_backup(archive_a.to_string_lossy().to_string()).unwrap();
        let merged_a: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(claude_dir.join("claude-deck-titles.json")).unwrap(),
        )
        .unwrap();

        assert_eq!(result_a.titles_added, 0);
        assert_eq!(result_a.titles_kept, 1);
        assert_eq!(
            merged_a,
            serde_json::json!({
                "k1": "current",
                "k2": "已有",
            })
        );

        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"k3\": \"new\",\n  \"k1\": \"old\"\n}\n",
        );
        let archive_b = home_dir.join("titles-b.tar.gz");
        export_all_projects(archive_b.to_string_lossy().to_string()).unwrap();

        write_file(
            &claude_dir.join("claude-deck-titles.json"),
            "{\n  \"k1\": \"current\"\n}\n",
        );
        let result_b = import_backup(archive_b.to_string_lossy().to_string()).unwrap();
        let merged_b: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(claude_dir.join("claude-deck-titles.json")).unwrap(),
        )
        .unwrap();

        assert_eq!(result_b.titles_added, 1);
        assert_eq!(result_b.titles_kept, 1);
        assert_eq!(
            merged_b,
            serde_json::json!({
                "k1": "current",
                "k3": "new",
            })
        );
    }

    #[test]
    fn import_backup_rejects_unsafe_entries() {
        let home_dir = temp_dir("import-unsafe-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let archive_path = home_dir.join("unsafe.tar.gz");
        write_custom_archive(
            &archive_path,
            &[("projects/p/sub/dir/file.jsonl", br#"{"type":"user"}"#)],
        );

        let err = import_backup(archive_path.to_string_lossy().to_string()).unwrap_err();

        assert!(err.contains("unsafe"));
        let projects_dir = home_dir.join(".claude").join("projects");
        assert!(
            !projects_dir.exists(),
            "unsafe archive should not create destination directories"
        );
    }

    #[test]
    fn import_backup_validates_archive_path() {
        let home_dir = temp_dir("import-invalid-home");
        let (_home_lock, _home_guard) = lock_home(&home_dir);

        let missing = home_dir.join("missing.tar.gz");
        let missing_err = import_backup(missing.to_string_lossy().to_string()).unwrap_err();

        let dir_path = home_dir.join("dir-archive");
        fs::create_dir_all(&dir_path).unwrap();
        let dir_err = import_backup(dir_path.to_string_lossy().to_string()).unwrap_err();

        let bad_file = home_dir.join("random-bytes.tar.gz");
        let mut file = File::create(&bad_file).unwrap();
        file.write_all(b"not-a-gzip").unwrap();
        file.sync_all().unwrap();
        drop(file);
        let bad_err = import_backup(bad_file.to_string_lossy().to_string()).unwrap_err();

        assert!(missing_err.contains("does not exist"));
        assert!(dir_err.contains("directory"));
        assert!(bad_err.contains("failed to read archive"));
    }

    #[test]
    fn replay_session_paged_tail_returns_last_n() {
        let dir = temp_dir("replay-paged-tail");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"one\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"content\":\"two\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u3\",\"message\":{\"content\":\"three\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a4\",\"message\":{\"content\":\"four\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u5\",\"message\":{\"content\":\"five\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a6\",\"message\":{\"content\":\"six\"}}\n",
            ),
        );

        let page = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(3),
                before_uuid: None,
            },
        )
        .unwrap();

        assert_eq!(page.messages.len(), 3);
        assert_eq!(page.messages[0].id, "a4");
        assert_eq!(page.messages[1].id, "u5");
        assert_eq!(page.messages[2].id, "a6");
        assert_eq!(page.returned_message_count, 3);
        assert_eq!(page.total_message_count, 6);
        assert!(page.has_more_before);
        assert_eq!(page.earliest_uuid.as_deref(), Some("a4"));
    }

    #[test]
    fn replay_session_paged_before_returns_prefix() {
        let dir = temp_dir("replay-paged-before");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"one\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"content\":\"two\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u3\",\"message\":{\"content\":\"three\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a4\",\"message\":{\"content\":\"four\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u5\",\"message\":{\"content\":\"five\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a6\",\"message\":{\"content\":\"six\"}}\n",
            ),
        );

        let page = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(3),
                before_uuid: Some("a4".into()),
            },
        )
        .unwrap();

        assert_eq!(page.messages.len(), 3);
        assert_eq!(page.messages[0].id, "u1");
        assert_eq!(page.messages[1].id, "a2");
        assert_eq!(page.messages[2].id, "u3");
        assert_eq!(page.returned_message_count, 3);
        assert_eq!(page.total_message_count, 6);
        assert!(!page.has_more_before);
        assert_eq!(page.earliest_uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn replay_session_paged_full_when_within_limit() {
        let dir = temp_dir("replay-paged-full");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"one\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"content\":\"two\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u3\",\"message\":{\"content\":\"three\"}}\n",
            ),
        );

        let page = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(10),
                before_uuid: None,
            },
        )
        .unwrap();

        assert_eq!(page.messages.len(), 3);
        assert_eq!(page.returned_message_count, 3);
        assert_eq!(page.total_message_count, 3);
        assert!(!page.has_more_before);
        assert_eq!(page.earliest_uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn replay_session_paged_stats_are_full_file() {
        let dir = temp_dir("replay-paged-stats");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"one\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"content\":\"two\",\"usage\":{\"input_tokens\":10,\"output_tokens\":20,\"cache_read_input_tokens\":2,\"cache_creation_input_tokens\":1},\"model\":\"claude-sonnet\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u3\",\"message\":{\"content\":\"three\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a4\",\"message\":{\"content\":\"four\",\"usage\":{\"input_tokens\":11,\"output_tokens\":21,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":2},\"model\":\"claude-sonnet\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a5\",\"message\":{\"content\":\"five\",\"usage\":{\"input_tokens\":12,\"output_tokens\":22,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":3},\"model\":\"claude-sonnet\"}}\n",
            ),
        );

        let page = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(2),
                before_uuid: None,
            },
        )
        .unwrap();

        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.turn_count, 3);
        assert_eq!(page.total_input_tokens, 33);
        assert_eq!(page.total_output_tokens, 63);
        assert_eq!(page.total_cache_read_tokens, 9);
        assert_eq!(page.total_cache_creation_tokens, 6);
        assert_eq!(page.last_input_tokens, 12);
        assert_eq!(page.last_output_tokens, 22);
    }

    #[test]
    fn replay_session_paged_invalid_before_errs() {
        let dir = temp_dir("replay-paged-invalid-before");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"one\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"content\":\"two\"}}\n",
            ),
        );

        let err = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(2),
                before_uuid: Some("missing".into()),
            },
        )
        .expect_err("missing before_uuid should error");

        assert!(err.contains("before_uuid not found"));
    }

    #[test]
    fn replay_session_keeps_existing_behavior() {
        let dir = temp_dir("replay-paged-compat");
        let file_path = dir.join("session.jsonl");
        write_file(
            &file_path,
            concat!(
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"reading\"},{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/App.tsx\"}}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"file contents\",\"is_error\":false}]}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a3\",\"message\":{\"content\":\"done\"}}\n",
            ),
        );

        let replay = replay_session(file_path.to_string_lossy().to_string()).unwrap();
        let page = replay_session_paged(
            file_path.to_string_lossy().to_string(),
            ReplayPageQuery {
                limit: Some(u32::MAX),
                before_uuid: None,
            },
        )
        .unwrap();

        assert_eq!(replay.messages.len(), page.messages.len());
    }
}
