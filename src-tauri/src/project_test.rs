//! Executes project checks only in a fresh, app-owned laboratory.
use crate::{
    database::Session,
    environment::{CreateEnvironmentRequest, Engine, Provider},
    graph_write,
    models::{ConnectionProfile, QueryResult},
    schema_changes,
    service::AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Deserialize)]
struct Request {
    engine: Engine,
    ddl: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    name: String,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Action {
    Read {
        query: String,
        #[serde(default)]
        params: BTreeMap<String, Value>,
    },
    Write {
        operation: graph_write::Operation,
    },
}

pub(crate) async fn test_remote(state: &AppState, args: Value) -> Result<Value, String> {
    if args.to_string().len() > 6 * 1024 * 1024 {
        return Err("La prova del progetto supera 6 MiB.".into());
    }
    let request_id = args["requestId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (_guard, mut cancel) = state.project_runs.begin(&request_id)?;
    let request: Request = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if request.steps.len() > 564 || request.engine == Engine::Sqlite {
        return Err("Motore o numero di passaggi di prova non valido.".into());
    }
    let available = state
        .environments
        .list()
        .await?
        .into_iter()
        .find(|environment| {
            environment.engine == request.engine
                && environment.laboratory
                && environment.initialized
                && environment.status == "running"
                && matches!(environment.provider, Provider::Native | Provider::Docker)
        })
        .ok_or("Avvia un laboratorio del motore selezionato per eseguire la prova reale.")?;
    let engine = serde_json::to_value(request.engine)
        .map_err(|e| e.to_string())?
        .as_str()
        .ok_or("Motore laboratorio non valido.")?
        .to_owned();
    let fresh = state
        .environments
        .create(CreateEnvironmentRequest {
            name: format!("Prova applicativa temporanea · {engine}"),
            engine: request.engine,
            provider: available.provider,
            laboratory: true,
            version: available.version,
            image_digest: available.image_digest,
            distribution_id: available.distribution_id,
            endpoint: None,
            port: None,
        })
        .await?;
    let work = async {
        if fresh.status != "running" || !fresh.initialized {
            return Err(fresh
                .last_error
                .clone()
                .unwrap_or_else(|| "Il laboratorio temporaneo non è pronto.".into()));
        }
        let session = Arc::new(
            Session::open(
                ConnectionProfile {
                    id: fresh.id.clone(),
                    name: fresh.name.clone(),
                    engine,
                    host: "127.0.0.1".into(),
                    port: fresh.port.ok_or("Porta del laboratorio mancante.")?,
                    database: "laboratory".into(),
                    username: fresh.username.clone().unwrap_or_default(),
                    laboratory: true,
                    ..Default::default()
                },
                state.environments.password(&fresh.id)?,
            )
            .await?,
        );
        let baseline = session.introspect().await?;
        let snapshot = schema_changes::apply(session.clone(), baseline, request.ddl, false).await?;
        let mut steps = vec![passed(
            "Creazione dello schema",
            "Schema applicato al laboratorio temporaneo.",
            None,
        )];
        for step in request.steps {
            let executed = match step.action {
                Action::Read { query, params } => session.execute(&query, params).await,
                Action::Write { mut operation } => {
                    operation.qualify_project_destination(&snapshot);
                    match operation.compile(&snapshot) {
                        Ok(compiled) => session.execute(&compiled.query, compiled.parameters).await,
                        Err(error) => Err(error),
                    }
                }
            };
            match executed {
                Ok(result) => steps.push(passed(
                    &step.name,
                    "Eseguita sul laboratorio reale.",
                    Some(result),
                )),
                Err(error) => {
                    steps.push(failed(&step.name, &error));
                    break;
                }
            }
        }
        Ok(steps)
    };
    let result = tokio::select! {
        biased;
        _=cancel.wait_for(|stopped| *stopped)=>Err("Prova interrotta.".into()),
        report=work=>report
    };
    let cleanup = state.environments.delete(&fresh.id, true).await;
    let mut steps =
        result.unwrap_or_else(|error: String| vec![failed("Preparazione del laboratorio", &error)]);
    if let Err(error) = cleanup {
        steps.push(failed("Chiusura del laboratorio temporaneo", &error));
    }
    Ok(json!({"steps":steps}))
}

fn passed(name: &str, detail: &str, result: Option<QueryResult>) -> Value {
    json!({"name":name,"status":"passed","detail":detail,"result":result})
}

fn failed(name: &str, detail: &str) -> Value {
    json!({"name":name,"status":"failed","detail":detail})
}
