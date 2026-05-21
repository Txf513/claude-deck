mod claude;
mod config;
mod path_util;
mod pty;
mod sessions;

use tauri_specta::{collect_commands, collect_events};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
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
            sessions::replay_session_paged,
            sessions::search_sessions,
            sessions::search_files,
            sessions::read_session_titles,
            sessions::rename_session,
            sessions::export_all_projects,
            sessions::export_project,
            sessions::import_backup,
            sessions::archive_session,
            sessions::delete_session,
            config::read_config,
            config::write_config,
            config::list_skills,
            config::list_agents,
            config::list_commands,
            config::list_plugins,
            config::set_plugin_enabled,
            config::save_paste_image,
            config::list_models,
            config::read_image_data_url,
            config::read_markdown_file,
            config::write_text_file,
            claude::claude_send,
            claude::claude_cancel,
        ])
        .events(collect_events![
            claude::ClaudeStreamEvent,
            claude::ClaudeStderrEvent,
            claude::ClaudeDoneEvent,
            pty::PtyDataEvent,
            pty::PtyExitEvent,
        ]);

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/lib/bindings.ts",
        )
        .expect("failed to export TS bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty::PtyState::default())
        .manage(claude::ClaudeState::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
