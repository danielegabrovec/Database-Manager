pub mod assistant;
pub mod codegen;
pub mod codegen_workbench;
pub mod database;
pub mod environment;
mod graph_write;
mod app_integration;
mod project_test;
pub mod lab;
mod local_ai;
pub mod models;
mod project_agent;
mod project_sync;
pub mod mongo_cancel;
pub mod mongo_edit;
mod ollama_lifecycle;
mod project_files;
mod quick_query;
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
        let mut context = tauri::generate_context!();
        // Explicitly isolated workspaces must not forward file-open requests to the default instance.
        if std::env::var_os("DBM_DATA_DIR").is_some() {
            use sha2::{Digest, Sha256};
            let ordinary = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir).join("DatabaseManager");
            if let Ok(root) = app.root.canonicalize() {
                let key = root.to_string_lossy().to_lowercase();
                if ordinary.canonicalize().ok().map(|p| p.to_string_lossy().to_lowercase()).as_ref() != Some(&key) {
                    let suffix = hex::encode(Sha256::digest(key.as_bytes()));
                    context.config_mut().identifier.push_str(&format!(".workspace.{}", &suffix[..24]));
                }
            }
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
            .run(context)
            .expect("Errore applicazione Tauri");
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
