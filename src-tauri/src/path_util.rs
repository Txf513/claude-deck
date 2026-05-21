use std::path::PathBuf;

/// Build a PATH that includes the user's likely shell paths even when the GUI
/// app launches without their shell rc loaded. Adds Homebrew, /usr/local, the
/// system bins, ~/.cargo/bin, and the latest ~/.nvm/versions/node/*/bin on top
/// of whatever PATH the process was started with.
pub fn augmented_path() -> String {
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
            let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
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

/// Find the `claude` binary by walking the augmented PATH, optionally honoring
/// an explicit override path provided by the caller.
pub fn resolve_claude_bin(explicit: Option<String>) -> Option<PathBuf> {
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

/// Return the user's HOME directory as a string, or an empty string if HOME
/// is unset. Exposed as a Tauri command so the frontend can derive paths
/// instead of hard-coding a developer's home directory.
#[tauri::command]
#[specta::specta]
pub fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}
