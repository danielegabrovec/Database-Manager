use crate::{
    assistant::{self, AiConfig, AiProvider, AiRequest, AiTurn},
    ollama_lifecycle::OllamaLifecycle,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::watch;

pub type Result<T> = std::result::Result<T, String>;
const MAX_CONVERSATIONS: i64 = 200;
const MAX_TURNS: usize = 120;
const MAX_CONVERSATION_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiConfig {
    pub endpoint: String,
    pub model: String,
    pub startup: Option<Startup>,
    #[serde(default = "off")]
    pub completion_mode: String,
}
fn off() -> String {
    "off".into()
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Startup {
    Manual,
    Automatic,
}

impl LocalAiConfig {
    pub fn from_settings(settings: &Value) -> Result<Self> {
        if let Some(value) = settings.get("localOllama") {
            return serde_json::from_value(value.clone())
                .map_err(|_| "Configurazione Ollama non valida.".into());
        }
        let old = &settings["ai"];
        let fallback = "http://127.0.0.1:11434";
        let local = old["provider"].as_str() != Some("openai-compatible");
        let safe_default = Self {
            endpoint: fallback.into(),
            model: String::new(),
            startup: None,
            completion_mode: off(),
        };
        if local {
            let migrated = Self {
                endpoint: old["baseUrl"].as_str().unwrap_or(fallback).into(),
                model: old["model"].as_str().unwrap_or_default().into(),
                startup: None,
                completion_mode: old["completionMode"].as_str().unwrap_or("off").into(),
            };
            if migrated.validate().is_ok() {
                return Ok(migrated);
            }
        }
        Ok(safe_default)
    }
    pub fn assistant(&self, timeout_seconds: u64) -> AiConfig {
        AiConfig {
            provider: AiProvider::Ollama,
            endpoint: self.endpoint.clone(),
            model: self.model.clone(),
            timeout_seconds,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.endpoint.len() > 500 || self.model.len() > 200 {
            return Err("Indirizzo o nome del modello Ollama troppo lungo.".into());
        }
        if !matches!(
            self.completion_mode.as_str(),
            "off" | "manual" | "automatic"
        ) {
            return Err("Modalità di completamento Ollama non riconosciuta.".into());
        }
        assistant::endpoint(&self.assistant(5), "api/tags")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatScope {
    Work,
    Quick,
}

impl ChatScope {
    fn key(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Quick => "quick",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPair {
    pub user: String,
    pub assistant: String,
    pub model: String,
    pub engine: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub scope: ChatScope,
    pub name: String,
    pub updated_at: String,
    pub turns: Vec<ChatPair>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    id: String,
    name: String,
    updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProgress {
    pub request_id: String,
    pub conversation_id: String,
    pub status: ChatState,
    pub content: String,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatState {
    Running,
    Complete,
    Cancelled,
    Failed,
}

struct ChatJob {
    progress: Arc<Mutex<ChatProgress>>,
    cancel: watch::Sender<bool>,
}

pub struct LocalAi {
    pub daemon: OllamaLifecycle,
    root: PathBuf,
    chats: Mutex<Option<Arc<ConversationStore>>>,
    jobs: Mutex<BTreeMap<String, ChatJob>>,
    cancellation: watch::Sender<u64>,
    auto_paused: AtomicBool,
}

impl LocalAi {
    pub fn new(root: &Path) -> Self {
        Self {
            daemon: OllamaLifecycle::default(),
            root: root.to_owned(),
            chats: Mutex::new(None),
            jobs: Mutex::new(BTreeMap::new()),
            cancellation: watch::channel(0u64).0,
            auto_paused: AtomicBool::new(false),
        }
    }
    fn chat_store(&self) -> Result<Arc<ConversationStore>> {
        let mut chats = lock(&self.chats)?;
        if let Some(chats) = chats.as_ref() {
            return Ok(chats.clone());
        }
        let opened = Arc::new(ConversationStore::open(&self.root)?);
        *chats = Some(opened.clone());
        Ok(opened)
    }
    pub fn cancellation_signal(&self) -> watch::Receiver<u64> {
        self.cancellation.subscribe()
    }
    pub fn cancel_all(&self) {
        self.cancellation
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }
    pub fn auto_allowed(&self) -> bool {
        !self.auto_paused.load(Ordering::Acquire)
    }
    pub fn pause_auto(&self, paused: bool) {
        self.auto_paused.store(paused, Ordering::Release);
    }
    pub fn list_chats(&self, scope: ChatScope) -> Result<Vec<ConversationSummary>> {
        self.chat_store()?.list(scope)
    }
    pub fn get_chat(&self, id: &str, scope: ChatScope) -> Result<Conversation> {
        valid_id(id)?;
        self.chat_store()?.get(id, scope)
    }
    pub fn rename_chat(&self, id: &str, scope: ChatScope, name: &str) -> Result<()> {
        valid_id(id)?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(
                "Il titolo della conversazione deve contenere da 1 a 120 caratteri.".into(),
            );
        }
        self.chat_store()?.rename(id, scope, name)
    }
    pub fn delete_chat(&self, id: &str, scope: ChatScope) -> Result<()> {
        valid_id(id)?;
        let jobs = lock(&self.jobs)?;
        if jobs.values().any(|job| {
            job.progress.lock().is_ok_and(|progress| {
                progress.conversation_id == id && progress.status == ChatState::Running
            })
        }) {
            return Err("Interrompi la risposta prima di eliminare la conversazione.".into());
        }
        self.chat_store()?.delete(id, scope)
    }
    pub fn progress(&self, request_id: &str) -> Result<ChatProgress> {
        valid_id(request_id)?;
        let jobs = lock(&self.jobs)?;
        let job = jobs
            .get(request_id)
            .ok_or("Risposta Ollama non disponibile.")?;
        let progress = lock(&job.progress)?.clone();
        Ok(progress)
    }
    pub fn cancel(&self, request_id: &str) -> Result<()> {
        valid_id(request_id)?;
        if let Some(job) = lock(&self.jobs)?.get(request_id) {
            job.cancel.send_replace(true);
        }
        Ok(())
    }
    pub fn submit(
        &self,
        request_id: String,
        conversation_id: &str,
        scope: ChatScope,
        mut request: AiRequest,
        mut global_cancel: watch::Receiver<u64>,
    ) -> Result<ChatProgress> {
        valid_id(&request_id)?;
        if request.prompt.trim().is_empty() || request.prompt.len() > 32 * 1024 {
            return Err("Scrivi un messaggio tra 1 e 32.768 byte.".into());
        }
        let mut jobs = lock(&self.jobs)?;
        if jobs.contains_key(&request_id) {
            return Err("Identificatore della richiesta Ollama già in uso.".into());
        }
        if jobs.values().any(|job| {
            job.progress
                .lock()
                .is_ok_and(|p| p.status == ChatState::Running)
        }) {
            return Err("Ollama sta già generando una risposta. Attendi o interrompila.".into());
        }
        if jobs.len() >= 16 {
            jobs.pop_first();
        }
        let chats = self.chat_store()?;
        let conversation = if conversation_id.is_empty() {
            chats.create(scope, &request.prompt)?
        } else {
            valid_id(conversation_id)?;
            chats.get(conversation_id, scope)?
        };
        if conversation.turns.len() >= MAX_TURNS {
            return Err("Conversazione oltre il limite. Aprine una nuova per continuare.".into());
        }
        request.history = conversation
            .turns
            .into_iter()
            .map(|pair| AiTurn {
                user: pair.user,
                assistant: pair.assistant,
            })
            .collect();
        let initial = ChatProgress {
            request_id: request_id.clone(),
            conversation_id: conversation.id.clone(),
            status: ChatState::Running,
            content: String::new(),
            error: None,
        };
        let progress = Arc::new(Mutex::new(initial.clone()));
        let (cancel, mut cancel_rx) = watch::channel(false);
        jobs.insert(
            request_id,
            ChatJob {
                progress: progress.clone(),
                cancel,
            },
        );
        tokio::spawn(async move {
            let user = request.prompt.clone();
            let model = request.config.model.clone();
            let engine = request.engine.clone();
            let outcome = tokio::select! {
                biased;
                _ = global_cancel.changed() => None,
                _ = cancel_rx.changed() => None,
                reply = assistant::stream_local_chat(request, |delta| {
                    if let Ok(mut state) = progress.lock() { state.content.push_str(delta); }
                }) => Some(reply),
            };
            if let Ok(mut state) = progress.lock() {
                match outcome {
                    Some(Ok(assistant)) => {
                        let pair = ChatPair {
                            user,
                            assistant,
                            model,
                            engine,
                            created_at: now(),
                        };
                        if let Err(error) = chats.append(&conversation.id, scope, pair) {
                            state.status = ChatState::Failed;
                            state.error = Some(error);
                        } else {
                            state.status = ChatState::Complete;
                        }
                    }
                    Some(Err(error)) => {
                        state.status = ChatState::Failed;
                        state.error = Some(error);
                    }
                    None => state.status = ChatState::Cancelled,
                }
            }
        });
        Ok(initial)
    }
}

struct ConversationStore {
    database: Mutex<Connection>,
}

impl ConversationStore {
    fn open(root: &Path) -> Result<Self> {
        let database = Connection::open(root.join("assistant-chats.sqlite")).map_err(error)?;
        database.execute_batch("PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS conversations(
              id TEXT PRIMARY KEY, scope TEXT NOT NULL,
              name TEXT NOT NULL, updated_at TEXT NOT NULL, transcript TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(scope, updated_at DESC);")
            .map_err(error)?;
        Ok(Self {
            database: Mutex::new(database),
        })
    }
    fn list(&self, scope: ChatScope) -> Result<Vec<ConversationSummary>> {
        let database = lock(&self.database)?;
        let mut stmt = database.prepare(
            "SELECT id, name, updated_at FROM conversations WHERE scope=?1 ORDER BY updated_at DESC LIMIT 200"
        ).map_err(error)?;
        let rows = stmt
            .query_map([scope.key()], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(error)?;
        let result = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(error)?;
        Ok(result)
    }
    fn create(&self, scope: ChatScope, text: &str) -> Result<Conversation> {
        let database = lock(&self.database)?;
        let count: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE scope=?1",
                [scope.key()],
                |row| row.get(0),
            )
            .map_err(error)?;
        if count >= MAX_CONVERSATIONS {
            return Err(
                "Raggiunto il limite di conversazioni. Elimina una chat per crearne un’altra."
                    .into(),
            );
        }
        let name = text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(72)
            .collect();
        let chat = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            scope,
            name,
            updated_at: now(),
            turns: Vec::new(),
        };
        database.execute(
            "INSERT INTO conversations(id, scope, name, updated_at, transcript) VALUES (?1,?2,?3,?4,'[]')",
            params![chat.id, scope.key(), chat.name, chat.updated_at],
        ).map_err(error)?;
        Ok(chat)
    }
    fn get(&self, id: &str, scope: ChatScope) -> Result<Conversation> {
        let database = lock(&self.database)?;
        get_chat(&database, id, scope)
    }
    fn append(&self, id: &str, scope: ChatScope, pair: ChatPair) -> Result<()> {
        let mut database = lock(&self.database)?;
        let save = database.transaction().map_err(error)?;
        let mut conversation = get_chat(&save, id, scope)?;
        conversation.turns.push(pair);
        let payload = serde_json::to_string(&conversation.turns).map_err(error)?;
        if payload.len() > MAX_CONVERSATION_BYTES {
            return Err(
                "Conversazione troppo grande per il salvataggio. Apri una nuova chat.".into(),
            );
        }
        save.execute(
            "UPDATE conversations SET updated_at=?1, transcript=?2 WHERE id=?3 AND scope=?4",
            params![now(), payload, id, scope.key()],
        )
        .map_err(error)?;
        save.commit().map_err(error)
    }
    fn rename(&self, id: &str, scope: ChatScope, name: &str) -> Result<()> {
        let count = lock(&self.database)?
            .execute(
                "UPDATE conversations SET name=?1 WHERE id=?2 AND scope=?3",
                params![name, id, scope.key()],
            )
            .map_err(error)?;
        if count != 1 {
            return Err("Conversazione non trovata.".into());
        }
        Ok(())
    }
    fn delete(&self, id: &str, scope: ChatScope) -> Result<()> {
        lock(&self.database)?
            .execute(
                "DELETE FROM conversations WHERE id=?1 AND scope=?2",
                params![id, scope.key()],
            )
            .map_err(error)?;
        Ok(())
    }
}

fn get_chat(database: &Connection, id: &str, scope: ChatScope) -> Result<Conversation> {
    let (name, updated_at, transcript): (String, String, String) = database
        .query_row(
            "SELECT name, updated_at, transcript FROM conversations WHERE id=?1 AND scope=?2",
            params![id, scope.key()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(error)?
        .ok_or("Conversazione non trovata.")?;
    Ok(Conversation {
        id: id.into(),
        scope,
        name,
        updated_at,
        turns: serde_json::from_str(&transcript).map_err(error)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    value
        .lock()
        .map_err(|_| "Archivio chat locale non disponibile.".into())
}
fn valid_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Identificatore chat non valido.".into())
}
