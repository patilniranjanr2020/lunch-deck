mod process_manager;
use process_manager::{open_url, spawn_process, stop_process, ProcessState};
use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let process_state = ProcessState::new();
    let state_exit = process_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(process_state)
        .invoke_handler(tauri::generate_handler![spawn_process, stop_process, open_url])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let RunEvent::Exit = event {
                state_exit.stop_all();
            }
        });
}
