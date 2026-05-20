mod claude;
mod config;
mod path_util;
mod pty;
mod sessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty::PtyState::default())
        .manage(claude::ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::resolve_claude_bin,
            path_util::get_home_dir,
            sessions::list_projects,
            sessions::list_sessions,
            sessions::replay_session,
            sessions::search_sessions,
            sessions::search_files,
            sessions::read_session_titles,
            sessions::rename_session,
            sessions::archive_session,
            sessions::delete_session,
            config::read_config,
            config::write_config,
            config::list_skills,
            config::list_plugins,
            config::set_plugin_enabled,
            config::save_paste_image,
            config::list_models,
            config::read_image_data_url,
            config::write_text_file,
            claude::claude_send,
            claude::claude_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
