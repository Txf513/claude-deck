use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

fn home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|e| e.to_string())
}

fn claude_dir() -> Result<PathBuf, String> {
    Ok(home()?.join(".claude"))
}

fn config_path(kind: &str) -> Result<PathBuf, String> {
    let dir = claude_dir()?;
    Ok(match kind {
        "settings" => dir.join("settings.json"),
        "settings_local" => dir.join("settings.local.json"),
        other => return Err(format!("unknown config kind: {}", other)),
    })
}

#[derive(Serialize)]
pub struct ConfigFile {
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub valid_json: bool,
    pub parse_error: Option<String>,
}

#[tauri::command]
pub fn read_config(kind: String) -> Result<ConfigFile, String> {
    let path = config_path(&kind)?;
    if !path.exists() {
        return Ok(ConfigFile {
            kind,
            path: path.to_string_lossy().to_string(),
            exists: false,
            content: String::new(),
            valid_json: true,
            parse_error: None,
        });
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (valid_json, parse_error) = match serde_json::from_str::<Value>(&content) {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };
    Ok(ConfigFile {
        kind,
        path: path.to_string_lossy().to_string(),
        exists: true,
        content,
        valid_json,
        parse_error,
    })
}

fn ensure_backup(target: &Path) -> Result<Option<PathBuf>, String> {
    if !target.exists() {
        return Ok(None);
    }
    let dir = claude_dir()?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let filename = target
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    let dest = dir.join(format!("{}.{}.bak", filename, ts));
    fs::copy(target, &dest).map_err(|e| e.to_string())?;
    Ok(Some(dest))
}

fn atomic_write(target: &Path, content: &str) -> Result<(), String> {
    let parent = target.parent().ok_or("no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = parent.to_path_buf();
    let stem = target
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".into());
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    tmp.push(format!(".{}.{}.tmp", stem, ts));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

#[derive(Serialize)]
pub struct WriteResult {
    pub path: String,
    pub backup: Option<String>,
}

#[tauri::command]
pub fn write_config(kind: String, content: String) -> Result<WriteResult, String> {
    let parsed: Value =
        serde_json::from_str(&content).map_err(|e| format!("invalid JSON: {}", e))?;
    let path = config_path(&kind)?;
    let backup = ensure_backup(&path)?;
    let pretty = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
    let final_content = if pretty.ends_with('\n') {
        pretty
    } else {
        format!("{}\n", pretty)
    };
    atomic_write(&path, &final_content)?;
    Ok(WriteResult {
        path: path.to_string_lossy().to_string(),
        backup: backup.map(|p| p.to_string_lossy().to_string()),
    })
}

#[derive(Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: String,
}

fn parse_skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    if !text.starts_with("---") {
        return (None, None);
    }
    let rest = &text[3..];
    let end = match rest.find("\n---") {
        Some(e) => e,
        None => return (None, None),
    };
    let block = &rest[..end];
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in block.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = Some(rest.trim().trim_matches('"').to_string());
        }
    }
    (name, description)
}

fn collect_skills_from(dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let content = match fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (name_fm, desc_fm) = parse_skill_frontmatter(&content);
        let folder_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        out.push(SkillInfo {
            name: name_fm.unwrap_or(folder_name.clone()),
            description: desc_fm.unwrap_or_default(),
            source: source.to_string(),
            path: skill_md.to_string_lossy().to_string(),
        });
    }
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillInfo>, String> {
    let mut out: Vec<SkillInfo> = Vec::new();
    let user = claude_dir()?.join("skills");
    if user.is_dir() {
        collect_skills_from(&user, "user", &mut out);
    }
    let plugins_root = claude_dir()?.join("plugins").join("cache");
    if let Ok(marketplaces) = fs::read_dir(&plugins_root) {
        for mp in marketplaces.flatten() {
            if !mp.path().is_dir() {
                continue;
            }
            let mp_name = mp.file_name().to_string_lossy().to_string();
            if let Ok(plugins) = fs::read_dir(mp.path()) {
                for pl in plugins.flatten() {
                    if !pl.path().is_dir() {
                        continue;
                    }
                    let pl_name = pl.file_name().to_string_lossy().to_string();
                    if let Ok(versions) = fs::read_dir(pl.path()) {
                        for ver in versions.flatten() {
                            let skills_dir = ver.path().join("skills");
                            if skills_dir.is_dir() {
                                let label = format!("{}::{}", mp_name, pl_name);
                                collect_skills_from(&skills_dir, &label, &mut out);
                            }
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub enabled: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub install_path: Option<String>,
}

fn read_settings_value() -> Result<Value, String> {
    let path = config_path("settings")?;
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("settings.json parse error: {}", e))
}

// Deep-merge `local` into `global`. Objects are merged key-by-key; for any
// other JSON shape (array, string, number, bool, null) the local value
// replaces the global value entirely. This matches the convention of
// `settings.local.json` overriding `settings.json` on a per-key basis.
fn merge_settings(global: &mut Value, local: Value) {
    match (global, local) {
        (Value::Object(g), Value::Object(l)) => {
            for (k, v) in l {
                match g.get_mut(&k) {
                    Some(existing) => merge_settings(existing, v),
                    None => {
                        g.insert(k, v);
                    }
                }
            }
        }
        (slot, other) => {
            *slot = other;
        }
    }
}

fn read_merged_settings() -> Result<Value, String> {
    let mut merged = read_settings_value().unwrap_or(Value::Object(Map::new()));
    let local_path = config_path("settings_local")?;
    if local_path.exists() {
        if let Ok(content) = fs::read_to_string(&local_path) {
            if let Ok(local) = serde_json::from_str::<Value>(&content) {
                merge_settings(&mut merged, local);
            }
        }
    }
    Ok(merged)
}

fn write_settings_value(value: &Value) -> Result<(), String> {
    let path = config_path("settings")?;
    ensure_backup(&path)?;
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let final_content = if pretty.ends_with('\n') {
        pretty
    } else {
        format!("{}\n", pretty)
    };
    atomic_write(&path, &final_content)
}

#[tauri::command]
pub fn list_plugins() -> Result<Vec<PluginInfo>, String> {
    let settings = read_merged_settings().unwrap_or(Value::Object(Map::new()));
    let enabled_map = settings
        .get("enabledPlugins")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let installed_path = claude_dir()?.join("plugins").join("installed_plugins.json");
    let mut installed_map: Map<String, Value> = Map::new();
    if installed_path.is_file() {
        if let Ok(content) = fs::read_to_string(&installed_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                if let Some(obj) = v.get("plugins").and_then(|x| x.as_object()) {
                    installed_map = obj.clone();
                }
            }
        }
    }

    let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for k in enabled_map.keys() {
        keys.insert(k.clone());
    }
    for k in installed_map.keys() {
        keys.insert(k.clone());
    }

    let mut out: Vec<PluginInfo> = Vec::new();
    for id in keys {
        let enabled = enabled_map
            .get(&id)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let installed_entries = installed_map.get(&id).and_then(|v| v.as_array());
        let installed = installed_entries.map(|a| !a.is_empty()).unwrap_or(false);
        let (version, install_path) = installed_entries
            .and_then(|a| a.first())
            .map(|first| {
                (
                    first
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    first
                        .get("installPath")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                )
            })
            .unwrap_or((None, None));
        out.push(PluginInfo {
            id,
            enabled,
            installed,
            version,
            install_path,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn set_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    let mut settings = read_settings_value()?;
    let obj = settings
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;
    let entry = obj
        .entry("enabledPlugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let map = entry
        .as_object_mut()
        .ok_or("enabledPlugins is not an object")?;
    map.insert(id, Value::Bool(enabled));
    write_settings_value(&settings)
}

#[tauri::command]
pub fn save_paste_image(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let dir = claude_dir()?.join("paste-cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_ext = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    let final_ext = if safe_ext.is_empty() {
        "png".to_string()
    } else {
        safe_ext
    };
    let id = uuid::Uuid::new_v4().to_string();
    let path = dir.join(format!("paste-{}.{}", id, final_ext));
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {}", path));
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("image too large (>8MB)".into());
    }
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tiff") => "image/tiff",
        Some("svg") => "image/svg+xml",
        Some("heic") => "image/heic",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[derive(Serialize)]
pub struct ModelOption {
    pub id: String,
    pub family: String,
    pub label: String,
    pub thinking: bool,
    pub context_1m: bool,
    pub source: String,
}

fn classify_family(model_id: &str) -> String {
    let lower = model_id.to_lowercase();
    if lower.contains("opus") {
        "opus".into()
    } else if lower.contains("sonnet") {
        "sonnet".into()
    } else if lower.contains("haiku") {
        "haiku".into()
    } else {
        "other".into()
    }
}

fn label_for(model_id: &str) -> String {
    let family = classify_family(model_id);
    let thinking = model_id.contains("thinking");
    let has_1m = model_id.contains("[1M]") || model_id.contains("[1m]");
    let mut parts: Vec<String> = vec![match family.as_str() {
        "opus" => "Opus".into(),
        "sonnet" => "Sonnet".into(),
        "haiku" => "Haiku".into(),
        _ => model_id.to_string(),
    }];
    // Pull out a version like 4-7 / 4-6 / 4-5 if present
    for token in model_id.split('-') {
        if token.len() == 3 && token.chars().nth(1) == Some('-') {
            // unlikely, skip
        }
    }
    if let Some(v) = extract_version(model_id) {
        parts[0] = format!("{} {}", parts[0], v);
    }
    if thinking {
        parts.push("thinking".into());
    }
    if has_1m {
        parts.push("1M".into());
    }
    parts.join(" · ")
}

fn extract_version(model_id: &str) -> Option<String> {
    // Look for patterns like 4-7, 4-6, 4-5
    let segments: Vec<&str> = model_id.split('-').collect();
    for i in 0..segments.len().saturating_sub(1) {
        if let (Ok(a), Ok(b)) = (segments[i].parse::<u32>(), segments[i + 1].parse::<u32>()) {
            if a < 10 && b < 10 {
                return Some(format!("{}.{}", a, b));
            }
        }
    }
    None
}

#[tauri::command]
pub fn list_models() -> Result<Vec<ModelOption>, String> {
    let mut out: Vec<ModelOption> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    let push = |id: &str,
                source: &str,
                list: &mut Vec<ModelOption>,
                seen: &mut std::collections::BTreeSet<String>| {
        if id.is_empty() || seen.contains(id) {
            return;
        }
        seen.insert(id.to_string());
        list.push(ModelOption {
            id: id.to_string(),
            family: classify_family(id),
            label: label_for(id),
            thinking: id.contains("thinking"),
            context_1m: id.contains("[1M]") || id.contains("[1m]"),
            source: source.to_string(),
        });
    };

    // 1) Built-in catalog of currently shipping Claude models.
    // Update when Anthropic releases new versions.
    const CATALOG: &[&str] = &[
        // Opus
        "claude-opus-4-7",
        "claude-opus-4-7-thinking",
        "claude-opus-4-7-thinking[1M]",
        "claude-opus-4-6",
        "claude-opus-4-6-thinking",
        "claude-opus-4-6-thinking[1M]",
        "claude-opus-4-5-20251101",
        "claude-opus-4-5-20251101-thinking",
        // Sonnet
        "claude-sonnet-4-6",
        "claude-sonnet-4-6-thinking",
        "claude-sonnet-4-6-thinking[1M]",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-5-20250929-thinking",
        // Haiku
        "claude-haiku-4-5-20251001",
        "claude-haiku-4-5-20251001-thinking",
    ];
    for id in CATALOG {
        push(id, "catalog", &mut out, &mut seen);
    }

    // 2) From the user's merged settings (settings.json + settings.local.json overrides).
    // Skip *_NAME aliases — they're CLI display labels, not separate models.
    if let Ok(v) = read_merged_settings() {
        if let Some(env) = v.get("env").and_then(|x| x.as_object()) {
            for (k, val) in env {
                let upper = k.to_uppercase();
                if upper.contains("MODEL") && !upper.ends_with("_NAME") {
                    if let Some(s) = val.as_str() {
                        push(s, "settings.env", &mut out, &mut seen);
                    }
                }
            }
        }
        if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
            push(m, "settings.model", &mut out, &mut seen);
        }
    }

    // 3) CLI aliases as quick-pick at the bottom of each family.
    for alias in ["opus", "sonnet", "haiku"] {
        push(alias, "alias", &mut out, &mut seen);
    }

    Ok(out)
}

#[tauri::command]
pub fn write_text_file(file_path: String, content: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}
