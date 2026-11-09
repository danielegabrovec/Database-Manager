use axum::{
    routing::{get, post},
    Json, Router,
};
use dbmanager_lib::assistant::{self, AiConfig, AiProvider, AiRequest, ContextConsent};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[tokio::test]
async fn ollama_remote_alias_is_rejected_before_user_context_is_sent() {
    let chats = Arc::new(AtomicUsize::new(0));
    let capture = chats.clone();
    let app=Router::new()
        .route("/api/tags",get(||async{Json(json!({"models":[{"name":"innocent-alias","size":342},{"name":"local-coder","size":900000000},{"name":"named-cloud:cloud","size":342},{"name":"remote-renamed","remote_host":"https://ollama.com","remote_model":"large"}]}))}))
        .route("/api/show",post(|Json(body):Json<Value>|async move{assert_eq!(body,json!({"model":"innocent-alias"}));Json(json!({"remote_host":"https://ollama.com","remote_model":"large"}))}))
        .route("/api/chat",post(move||{let capture=capture.clone();async move{capture.fetch_add(1,Ordering::SeqCst);Json(json!({"message":{"content":"Must not be reached"}}))}}));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = AiConfig {
        provider: AiProvider::Ollama,
        endpoint: format!("http://127.0.0.1:{port}"),
        model: "innocent-alias".into(),
        timeout_seconds: 10,
    };
    let models = assistant::list_ollama_models(&config).await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        vec!["innocent-alias", "local-coder"]
    );
    let request = AiRequest {
        config,
        prompt: "PRIVATE_PROMPT".into(),
        engine: Some("sqlite".into()),
        consent: ContextConsent {
            include_query: true,
            include_schema: true,
            include_rows: true,
        },
        query: Some("PRIVATE_QUERY".into()),
        schema: Some(json!({"private":true})),
        rows: Some(json!([{"private":true}])),
    };
    let error = assistant::complete(request, None).await.unwrap_err();
    assert!(error.contains("remoto"));
    assert_eq!(chats.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
#[ignore = "Runs one synthetic, local-only Ollama request against the existing qwen2.5-coder:1.5b-base model; never downloads models or uses cloud."]
async fn existing_ollama_local_synthetic_select_smoke() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let config = AiConfig {
        provider: AiProvider::Ollama,
        endpoint: "http://127.0.0.1:11434".into(),
        model: "qwen2.5-coder:1.5b-base".into(),
        timeout_seconds: 120,
    };
    let listed = assistant::list_ollama_models(&config)
        .await
        .expect("Existing local Ollama must be running");
    assert!(listed.iter().any(|m| m.name == config.model));
    let request = AiRequest {
        config,
        prompt: "Scrivi soltanto questa query SQL, senza spiegazioni: SELECT 1 AS risultato;"
            .into(),
        engine: Some("sqlite".into()),
        consent: ContextConsent::default(),
        query: None,
        schema: None,
        rows: None,
    };
    let response =
        tokio::time::timeout(Duration::from_secs(120), assistant::complete(request, None))
            .await
            .expect("120 second maximum for this synthetic request")
            .expect("Local model must return a textual answer");
    let receipt = json!({"status":"passed","provider":"ollama-local","endpoint":"http://127.0.0.1:11434","model":response.model,"syntheticPrompt":"SELECT 1 AS risultato","response":response.content,"elapsedMs":response.elapsed_ms,"includedContext":response.included_context,"cloudForwardingAllowed":false});
    std::fs::write(
        workspace.join("artifacts/qa-ollama.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    assert!(receipt["response"]
        .as_str()
        .unwrap()
        .to_uppercase()
        .contains("SELECT"));
    assert!(receipt["includedContext"].as_array().unwrap().is_empty());
}
