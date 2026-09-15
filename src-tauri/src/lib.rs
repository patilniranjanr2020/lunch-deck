mod process_manager;
use process_manager::{open_url, spawn_process, stop_process, ProcessState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProcessState::new())
        .invoke_handler(tauri::generate_handler![spawn_process, stop_process, open_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
