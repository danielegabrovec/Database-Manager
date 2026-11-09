use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use dbmanager_lib::service::{default_data_dir, AppState};
use serde_json::{json, Value};
use std::sync::Arc;

async fn rpc(
    State(state): State<Arc<AppState>>,
    Path(command): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if let Some(origin) = headers.get("origin") {
        let allowed = [
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "http://127.0.0.1:8787",
            "http://localhost:8787",
        ];
        if !origin
            .to_str()
            .map(|s| allowed.contains(&s))
            .unwrap_or(false)
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Origine non autorizzata"})),
            );
        }
    }
    match state.call(&command, args).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error":e}))),
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = default_data_dir();
    let state = Arc::new(AppState::new(root.clone()).map_err(std::io::Error::other)?);
    let app = Router::new()
        .route("/api/{command}", post(rpc))
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","backend":"rust","version":"0.2.0"})) }),
        )
        .fallback_service(
            tower_http::services::ServeDir::new("../dist").append_index_html_on_directories(true),
        )
        .layer(axum::extract::DefaultBodyLimit::max(36 * 1024 * 1024))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
    println!(
        "Database Manager Rust bridge http://127.0.0.1:8787 · dati {}",
        root.display()
    );
    axum::serve(listener, app).await?;
    Ok(())
}
