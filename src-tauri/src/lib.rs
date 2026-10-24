mod api;
mod sse;
mod state;
mod update;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::new(app.handle().clone());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::configure_server,
            api::auth_config,
            api::login,
            api::register,
            api::logout,
            api::has_session,
            api::try_resume,
            api::session_tree,
            api::create_chat,
            api::rename_chat,
            api::delete_chat,
            api::fork_chat,
            api::history,
            api::rewind_history,
            api::send_message,
            api::cancel,
            api::cancel_queued,
            api::respond_ask_user,
            api::session_status,
            api::rpc,
            api::upload_file,
            api::fs_list,
            api::upload_bytes,
            api::pick_file,
            api::open_external,
            api::start_sse,
            api::stop_sse,
            update::app_version,
            update::check_update,
            update::download_update,
            update::apply_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running xbot desktop");
}
