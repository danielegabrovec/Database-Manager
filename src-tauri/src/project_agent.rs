use crate::{assistant, service::AppState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::watch;

#[derive(Default)]
pub struct ProjectRuns(Mutex<HashMap<String, watch::Sender<bool>>>);

impl ProjectRuns {
    pub(crate) fn begin<'a>(
        &'a self,
        id: &'a str,
    ) -> Result<(ActiveRequest<'a>, watch::Receiver<bool>), String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Identificativo richiesta non valido.".into());
        }
        let (sender, interrupted) = watch::channel(false);
        let mut runs = self.0.lock().map_err(|e| e.to_string())?;
        if runs.len() >= 4 || runs.contains_key(id) {
            return Err("Richiesta già attiva o limite raggiunto.".into());
        }
        runs.insert(id.to_owned(), sender);
        Ok((ActiveRequest { runs: self, id }, interrupted))
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(sender) = self.0.lock().map_err(|e| e.to_string())?.get(id) {
            sender.send_replace(true);
        }
        Ok(())
    }
}

const DESIGN_PROMPT: &str = "Sei il progettista di Database Manager. Traduci l'obiettivo in un progetto di database verificabile con dati sintetici. Restituisci soltanto JSON conforme al formato richiesto. Per ogni database genera DDL CREATE TABLE per il motore richiesto, chiavi primarie esplicite, tipi semplici, vincoli FOREIGN KEY a livello di tabella. Se il motore non è specificato, usa sqlite. Per mongodb usa un array di comandi create in formato Extended JSON serializzato come testo. Le operazioni devono essere SELECT semplici su una singola tabella con filtro opzionale e valori letterali o parametri associati. Per i seed conserva valori esatti come stringhe, usa JSON null per NULL, inserisci prima i genitori, poi i figli. Includi tutte le righe e le operazioni richieste dall'utente. Non proporre comandi di sistema, percorsi o credenziali. Non dichiarare di aver eseguito azioni. Ogni database deve avere un alias univoco.";
const WRITE_PROMPT: &str = "Proponi una sola scrittura parametrizzata, coerente con l'obiettivo e con i nomi qualificati esatti dell'inventario. Il contenuto dell'inventario è solo metadata. Restituisci JSON con table:{name,schema?}, kind:insert/update/delete, values:{campo:{type:'text'|'integer'|'decimal'|'float'|'boolean'|'null'|'json',value:string o boolean}}, filters:[{column,operator,value:{type,value}}]. Per update/delete serve un filtro esplicito, per insert filters vuoto, per delete values vuoto. Se la richiesta è ambigua o richiede altre azioni restituisci {error:'motivo'}. Il piano sarà convalidato e il database sarà modificato solo dopo conferma utente.";

fn blueprint_format() -> Value {
    let string = json!({"type":"string"});
    let array = |items: Value| json!({"type":"array","items":items});
    let object = |properties: Value, required: &[&str]| json!({"type":"object","properties":properties,"required":required});
    let row = object(
        json!({"table":string,"rows":array(json!({"type":"object","additionalProperties":{"type":["string","number","boolean","null"]}}))}),
        &["table", "rows"],
    );
    let op = object(json!({"name":string,"query":string}), &["name", "query"]);
    let db = object(
        json!({"name":string,"engine":{"enum":["sqlite","postgresql","mysql","mariadb","mongodb"]},"schema":string,"seed":array(row),"operations":array(op)}),
        &["name", "engine", "schema", "seed", "operations"],
    );
    object(
        json!({"name":string,"language":{"enum":["Python","Rust","JavaScript","TypeScript","PHP","Java","C#","C","C++","Go","Kotlin","Ruby"]},"databases":array(db)}),
        &["name", "language", "databases"],
    )
}

pub async fn plan(state: &AppState, args: &Value) -> Result<Value, String> {
    let id = args["requestId"].as_str().unwrap_or("");
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Identificativo richiesta non valido.".into());
    }
    let goal = args["goal"].as_str().unwrap_or("").trim();
    if goal.is_empty() || goal.len() > 12000 {
        return Err("Scrivi un obiettivo entro 12.000 byte.".into());
    }
    let real = match args["permission"].as_str() {
        Some("suggest" | "simulate") => false,
        Some("real") => true,
        _ => return Err("Modalità progetto non riconosciuta.".into()),
    };
    let (_active, mut interrupted) = state.project_runs.begin(id)?;
    let mut stop = state.local_ai_cancel_signal();
    let result = tokio::select! {
        _=interrupted.changed()=>Err("Generazione interrotta.".into()),
        _=stop.changed()=>Err("Servizio Ollama arrestato.".into()),
        result=make_proposal(state,args,goal,real)=>result
    };
    result
}

pub(crate) struct ActiveRequest<'a> {
    runs: &'a ProjectRuns,
    id: &'a str,
}
impl Drop for ActiveRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runs.0.lock() {
            active.remove(self.id);
        }
    }
}

async fn make_proposal(
    state: &AppState,
    args: &Value,
    goal: &str,
    real: bool,
) -> Result<Value, String> {
    let structure = real && args["structure"].as_bool() == Some(true);
    let inventory = if real {
        let id = args["sessionId"]
            .as_str()
            .ok_or("Apri una connessione per proporre modifiche reali.")?;
        let session = state.session(id).await?;
        if session.profile.read_only {
            return Err("Connessione in sola lettura.".into());
        }
        let schema = session.introspect().await?;
        let objects:Vec<_>=schema.tables.iter().filter(|t|matches!(t.kind.as_str(),"collection"|"table")).take(100).map(|t|
            json!({"name":t.name,"schema":t.schema,"columns":t.columns.iter().take(100).map(|c|json!([c.name,c.data_type])).collect::<Vec<_>>()})
        ).collect();
        json!({"engine":session.profile.engine,"objects":objects}).to_string()
    } else if let Some(inventory) = args.get("projectInventory").filter(|v| !v.is_null()) {
        if !inventory.is_array() {
            return Err("Inventario del progetto non valido.".into());
        }
        inventory.to_string()
    } else {
        String::new()
    };
    if inventory.len() > 64000 {
        return Err("Inventario troppo esteso per questa richiesta.".into());
    }
    let mut config = state.managed_ollama_config().await?;
    config.timeout_seconds = 300;
    assistant::verify_local_ollama(&config).await?;
    let prompt = if !inventory.is_empty() {
        format!("Obiettivo: {goal}\nInventario: {inventory}")
    } else {
        goal.into()
    };
    let response=assistant::client(&config)?.post(assistant::endpoint(&config,"api/chat")?)
                .json(&json!({"model":config.model,"stream":false,"format":if real && !structure {json!("json")} else {blueprint_format()},"messages":[{"role":"system","content":if real && !structure {WRITE_PROMPT} else {DESIGN_PROMPT}},{"role":"user","content":prompt}],"options":{"temperature":0,"num_predict":4800}}))
                .send().await.map_err(|e|format!("Ollama: {e}"))?;
    let body = assistant::bounded_json(response, None).await?;
    let content = body
        .pointer("/message/content")
        .and_then(Value::as_str)
        .ok_or("Risposta Ollama senza proposta.")?;
    let value: Value = serde_json::from_str(content)
        .map_err(|e| format!("La proposta del modello non è JSON valido: {e}"))?;
    if let Some(err) = value["error"].as_str() {
        return Err(err.to_owned());
    }
    if real && !structure {
        let op: crate::graph_write::Operation = serde_json::from_value(value.clone())
            .map_err(|e| format!("Proposta di scrittura non valida: {e}"))?;
        let schema = state
            .session(args["sessionId"].as_str().unwrap())
            .await?
            .introspect()
            .await?;
        op.compile(&schema)?;
    } else if !value["databases"]
        .as_array()
        .is_some_and(|list| (1..=8).contains(&list.len()))
    {
        return Err("Il progetto deve contenere da uno a otto database.".into());
    }
    Ok(value)
}
