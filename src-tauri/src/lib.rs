pub mod assistant;
pub mod codegen;
pub mod codegen_workbench;
pub mod database;
pub mod environment;
pub mod lab;
pub mod models;
pub mod mongo_cancel;
pub mod mongo_edit;
pub mod remote;
pub mod service;
pub mod schema_changes;
pub mod sqlite;
pub mod store;
pub mod tools;
pub mod windows_service;
pub mod workspace_files;

#[cfg(feature = "desktop")]
mod desktop {
    use super::service::{default_data_dir, AppState};
    use serde_json::{json, Value};
    use std::sync::Arc;
    #[tauri::command]
    pub async fn backend_call(
        state: tauri::State<'_, Arc<AppState>>,
        command: String,
        args: Option<Value>,
    ) -> Result<Value, String> {
        state.call(&command, args.unwrap_or(json!({}))).await
    }
    #[tauri::command]
    pub async fn execute_query_stream(
        state: tauri::State<'_, Arc<AppState>>,
        session_id: String,
        query: String,
        parameters: Option<Value>,
        on_event: tauri::ipc::Channel<Value>,
    ) -> Result<(), String> {
        let result=state.call("execute_query",json!({"sessionId":session_id,"query":query,"parameters":parameters.unwrap_or(json!({}))})).await?;
        if let Some(sets) = result["sets"].as_array() {
            for (i, set) in sets.iter().enumerate() {
                on_event.send(json!({"event":"columns","setIndex":i,"columns":set["columns"],"truncated":set["truncated"]})).map_err(|e|e.to_string())?;
                if let Some(rows) = set["rows"].as_array() {
                    for chunk in rows.chunks(250) {
                        on_event
                            .send(json!({"event":"rows","setIndex":i,"rows":chunk}))
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        on_event.send(json!({"event":"complete","elapsedMs":result["elapsedMs"],"affectedRows":result["affectedRows"],"message":result["message"]})).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn run() {
        let app = match AppState::new(default_data_dir()) {
            Ok(state) => Arc::new(state),
            Err(e) => {
                eprintln!("Avvio non riuscito: {e}");
                return;
            }
        };
        let arguments = std::env::args().collect::<Vec<_>>();
        if let Ok(cwd) = std::env::current_dir() {
            app.queue_workspace_arguments(&arguments, &cwd);
        }
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
                use tauri::Manager;
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state.queue_workspace_arguments(&arguments, std::path::Path::new(&cwd));
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .manage(app)
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .invoke_handler(tauri::generate_handler![backend_call, execute_query_stream])
            .run(tauri::generate_context!())
            .expect("Errore applicazione Tauri");
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
