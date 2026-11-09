use super::templates::{self, Template};
use super::*;
pub(super) fn generate(ctx: &Context) -> Result<GeneratedProject, String> {
    if !["rust", "python", "javascript", "typescript"].contains(&ctx.req.language.as_str()) {
        return Err(
            "REST è disponibile per Rust/Axum, Python/FastAPI e JavaScript/TypeScript/Fastify"
                .into(),
        );
    }
    if ctx.keys.is_empty() {
        return Err("REST CRUD richiede una chiave primaria stabile".into());
    }
    let mut template = templates::build(ctx)?;
    let mut files = Vec::new();
    let command: String;
    match ctx.req.language.as_str() {
        "python" => {
            files.push(file(&template.path, template.source));
            files.push(file("server.py",r#"from fastapi import FastAPI, HTTPException, Body
from fastapi.concurrency import run_in_threadpool
from database import execute

app = FastAPI(title='Database API', version='1.0.0')

async def run(operation, payload):
    try:
        return await run_in_threadpool(execute, operation, payload)
    except Exception as error:
        raise HTTPException(status_code=400, detail='Operazione database non riuscita; verificare payload, schema e connessione') from error

@app.get('/health')
async def health(): return {'status': 'ok'}

@app.get('/records')
async def read_records(): return await run('list', {})

@app.post('/records', status_code=201)
async def create_record(payload: dict = Body(...)): return await run('insert', payload)

@app.put('/records')
async def update_record(payload: dict = Body(...)): return await run('update', payload)

@app.delete('/records')
async def delete_record(payload: dict = Body(...)): return await run('delete', payload)
"#));
            template
                .files
                .iter_mut()
                .filter(|f| f.path == "requirements.txt")
                .for_each(|f| f.content.push_str("fastapi>=0.115,<1\nuvicorn>=0.34,<1\n"));
            command="python -m pip install -r requirements.txt; python -m uvicorn server:app --host 127.0.0.1 --port 3000".into();
        }
        "javascript" | "typescript" => {
            let ts = ctx.req.language == "typescript";
            files.push(file(&template.path, template.source));
            files.push(file(if ts{"server.ts"}else{"server.js"},format!(r#"import Fastify from 'fastify';
import {{ execute, encode }} from './database.js';
const server = Fastify({{ logger: true, bodyLimit: 1048576 }});
server.get('/health', async () => ({{ status: 'ok' }}));
server.get('/records', async (_request, reply) => {{
  try {{ reply.type('application/json'); return encode(await execute('list', {{}})); }}
  catch {{ reply.code(400); return {{ error: 'Operazione database non riuscita' }}; }}
}});
for (const [method, operation] of [['POST', 'insert'], ['PUT', 'update'], ['DELETE', 'delete']]{}) {{
  server.route({{ method, url: '/records', schema: {{ body: {{ type: 'object', additionalProperties: true }} }}, handler: async (request, reply) => {{
    try {{ reply.type('application/json'); if (operation === 'insert') reply.code(201); return encode(await execute(operation, request.body)); }}
    catch {{ reply.code(400); return {{ error: 'Operazione database non riuscita; verificare payload, schema e connessione' }}; }}
  }} }});
}}
await server.listen({{ host: '127.0.0.1', port: 3000 }});
"#,if ts{" as const"}else{""})));
            let manifest = template
                .files
                .iter_mut()
                .find(|f| f.path == "package.json")
                .ok_or("Manifest Node mancante")?;
            let mut data: Value =
                serde_json::from_str(&manifest.content).map_err(|e| e.to_string())?;
            data["dependencies"]["fastify"] = json!("^5.2.0");
            data["scripts"]["start"] = json!(if ts {
                "node dist/server.js"
            } else {
                "node server.js"
            });
            manifest.content = serde_json::to_string_pretty(&data).unwrap();
            command = if ts {
                "npm install; npm run build; npm start"
            } else {
                "npm install; npm start"
            }
            .into();
        }
        _ => {
            files.push(file("src/database.rs", template.source));
            files.push(file("src/main.rs",r#"mod database;
use axum::{routing::{get, post, put, delete}, Json, Router, http::StatusCode};
use serde_json::{json, Value};
type Response = Result<Json<Value>, (StatusCode, Json<Value>)>;
async fn run(operation: &str, payload: Value) -> Response {
    database::execute(operation, payload).await.map(Json).map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error":"Operazione database non riuscita; verificare payload, schema e connessione"}))))
}
async fn list() -> Response { run("list", json!({})).await }
async fn insert(Json(payload): Json<Value>) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> { run("insert", payload).await.map(|body| (StatusCode::CREATED, body)) }
async fn update(Json(payload): Json<Value>) -> Response { run("update", payload).await }
async fn remove(Json(payload): Json<Value>) -> Response { run("delete", payload).await }
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let application = Router::new().route("/health", get(|| async { Json(json!({"status":"ok"})) })).route("/records", get(list).post(insert).put(update).delete(remove));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    axum::serve(listener, application).await?;
    Ok(())
}
"#));
            let manifest = template
                .files
                .iter_mut()
                .find(|f| f.path == "Cargo.toml")
                .ok_or("Manifest Rust mancante")?;
            manifest.content.push_str("axum = \"0.8\"\n");
            manifest.content = manifest
                .content
                .replace("\"rt-multi-thread\"]", "\"rt-multi-thread\", \"net\"]");
            command = "cargo run".into();
        }
    }
    files.extend(template.files);
    files.extend(templates::common_files(
        ctx,
        &command,
        &template.dependencies,
    ));
    files.push(file("API.md","# API locale\n\nAscolta esclusivamente su `127.0.0.1:3000`.\n\n- GET /health: vitalità del processo.\n- GET /records: query configurata, massimo 100 record.\n- POST /records: oggetto JSON con i campi richiesti, incluse le chiavi.\n- PUT /records: oggetto JSON con tutte le chiavi e tutti i campi non chiave.\n- DELETE /records: oggetto JSON con tutte le chiavi.\n\nLe chiavi nel corpo supportano anche PK composite. Gli errori database non sono esposti come dettagli HTTP. Questa API è un progetto locale senza autenticazione: prima di pubblicarla aggiungere autenticazione e autorizzazione applicativa.\n"));
    Ok(GeneratedProject{files,command,notes:vec!["API CRUD locale completa: /records usa le chiavi nel payload e supporta PK composite; ascolto predefinito su loopback, errori HTTP senza dettagli del driver.".into()]})
}

pub(super) fn native_c(ctx: &Context) -> Result<Template, String> {
    let cpp = ctx.req.language == "cpp";
    let (headers,packages,links,ports)=match ctx.req.engine.as_str(){
        "sqlite"=>("#include <sqlite3.h>","find_package(unofficial-sqlite3 CONFIG REQUIRED)","unofficial::sqlite3::sqlite3",vec!["sqlite3","cjson"]),
        "postgresql"=>("#include <libpq-fe.h>","find_package(PostgreSQL REQUIRED)","PostgreSQL::PostgreSQL",vec!["libpq","cjson"]),
        "mongodb"=>("#include <mongoc/mongoc.h>\n#include <bson/bson.h>","find_package(mongoc 2 CONFIG REQUIRED)","mongoc::mongoc",vec!["mongo-c-driver","cjson"]),
        _=>("#include <mysql.h>","find_path(MARIADB_INCLUDE_DIR mysql.h PATH_SUFFIXES mariadb mysql REQUIRED)\nfind_library(MARIADB_LIBRARY NAMES mariadb libmariadb REQUIRED)\ntarget_include_directories(database_example PRIVATE ${MARIADB_INCLUDE_DIR})", "${MARIADB_LIBRARY}",vec!["libmariadb","cjson"])};
    let sqlite = r#"
static cJSON *database_operation(const char *operation, cJSON *payload, const char *sql, cJSON *fields) {
    sqlite3 *connection = NULL;
    if (sqlite3_open(getenv("DATABASE_URL") ? getenv("DATABASE_URL") : "./database.sqlite", &connection) != SQLITE_OK) fail("Connessione SQLite non riuscita");
    OWN(connection, sqlite3_close);
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(connection, sql, -1, &statement, NULL) != SQLITE_OK) fail(sqlite3_errmsg(connection));
    OWN(statement, sqlite3_finalize);
    cJSON *field; int parameter = 1;
    cJSON_ArrayForEach(field, fields) {
        cJSON *value = required_field(payload, field->valuestring); int status;
        if (cJSON_IsNull(value)) status = sqlite3_bind_null(statement, parameter);
        else if (cJSON_IsBool(value)) status = sqlite3_bind_int(statement, parameter, cJSON_IsTrue(value));
        else if (cJSON_IsNumber(value)) { exact_number(value); status = sqlite3_bind_double(statement, parameter, value->valuedouble); }
        else if (cJSON_IsString(value)) status = sqlite3_bind_text(statement, parameter, value->valuestring, -1, SQLITE_TRANSIENT);
        else { char *text = cJSON_PrintUnformatted(value); status = sqlite3_bind_text(statement, parameter, text, -1, SQLITE_TRANSIENT); cJSON_free(text); }
        if (status != SQLITE_OK) fail(sqlite3_errmsg(connection)); ++parameter;
    }
    cJSON *result = cJSON_CreateArray(); int status;
    while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
        if (cJSON_GetArraySize(result) >= 100) break;
        cJSON *record = cJSON_CreateObject();
        for (int i=0; i<sqlite3_column_count(statement); ++i) {
            cJSON *value = NULL; int type = sqlite3_column_type(statement, i);
            if (type == SQLITE_NULL) value = cJSON_CreateNull();
            else if (type == SQLITE_INTEGER) { char number[32]; snprintf(number, sizeof(number), "%lld", (long long)sqlite3_column_int64(statement, i)); value = cJSON_CreateString(number); }
            else if (type == SQLITE_FLOAT) value = cJSON_CreateNumber(sqlite3_column_double(statement, i));
            else if (type == SQLITE_BLOB) { const unsigned char *data=(const unsigned char *)sqlite3_column_blob(statement,i); value=cJSON_CreateArray();for(int n=0;n<sqlite3_column_bytes(statement,i);++n)cJSON_AddItemToArray(value,cJSON_CreateNumber(data[n])); }
            else value=cJSON_CreateString((const char *)sqlite3_column_text(statement,i));
            cJSON_AddItemToObject(record, sqlite3_column_name(statement,i), value);
        }
        cJSON_AddItemToArray(result,record);
    }
    if (status != SQLITE_DONE && status != SQLITE_ROW) { cJSON_Delete(result); fail(sqlite3_errmsg(connection)); }
    if (strcmp(operation,"list")) { cJSON_Delete(result); result=cJSON_CreateObject(); cJSON_AddNumberToObject(result,"affected",sqlite3_changes(connection)); }
    CLEAN(statement,sqlite3_finalize);CLEAN(connection,sqlite3_close);return result;
}
"#;
    let postgres = r#"
static cJSON *database_operation(const char *operation,cJSON *payload,const char *sql,cJSON *fields) {
    const char *url=getenv("DATABASE_URL");if(!url)fail("Impostare DATABASE_URL");
    PGconn *connection=PQconnectdb(url);OWN(connection,PQfinish);if(PQstatus(connection)!=CONNECTION_OK)fail(PQerrorMessage(connection));
    int count=cJSON_GetArraySize(fields);char **values=(char **)calloc((size_t)count+1,sizeof(char *));if(!values)fail("Memoria insufficiente");
    for(int i=0;i<count;++i)values[i]=parameter_text(required_field(payload,cJSON_GetArrayItem(fields,i)->valuestring));
    PGresult *rows=PQexecParams(connection,sql,count,NULL,(const char *const *)values,NULL,NULL,0);
    for(int i=0;i<count;++i)free(values[i]);free(values);OWN(rows,PQclear);
    if(PQresultStatus(rows)!=PGRES_TUPLES_OK&&PQresultStatus(rows)!=PGRES_COMMAND_OK)fail(PQresultErrorMessage(rows));
    cJSON *result=cJSON_CreateArray();
    if(!strcmp(operation,"list")){for(int r=0;r<PQntuples(rows)&&r<100;++r){cJSON *record=cJSON_CreateObject();for(int c=0;c<PQnfields(rows);++c)cJSON_AddItemToObject(record,PQfname(rows,c),PQgetisnull(rows,r,c)?cJSON_CreateNull():cJSON_CreateString(PQgetvalue(rows,r,c)));cJSON_AddItemToArray(result,record);}}
    else{cJSON_Delete(result);result=cJSON_CreateObject();cJSON_AddStringToObject(result,"affected",PQcmdTuples(rows));}
    CLEAN(rows,PQclear);CLEAN(connection,PQfinish);return result;
}
"#;
    let mysql = r#"
static cJSON *database_operation(const char *operation,cJSON *payload,const char *sql,cJSON *fields) {
    const char *host=getenv("DB_HOST"),*user=getenv("DB_USER"),*password=getenv("DB_PASSWORD"),*database=getenv("DB_NAME"),*port=getenv("DB_PORT");
    if(!user||!database)fail("Impostare DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME");
    MYSQL *connection=mysql_init(NULL);if(!connection)fail("Memoria insufficiente");OWN(connection,mysql_close);
    if(getenv("DB_PLUGIN_DIR"))mysql_options(connection,MYSQL_PLUGIN_DIR,getenv("DB_PLUGIN_DIR"));
    if(!mysql_real_connect(connection,host?host:"127.0.0.1",user,password?password:"",database,port?(unsigned int)strtoul(port,NULL,10):3306,NULL,0))fail(mysql_error(connection));
    MYSQL_STMT *statement=mysql_stmt_init(connection);if(!statement)fail("Creazione statement non riuscita");OWN(statement,mysql_stmt_close);
    if(mysql_stmt_prepare(statement,sql,(unsigned long)strlen(sql)))fail(mysql_stmt_error(statement));
    int count=cJSON_GetArraySize(fields);MYSQL_BIND *params=(MYSQL_BIND *)calloc((size_t)count+1,sizeof(MYSQL_BIND));char **values=(char **)calloc((size_t)count+1,sizeof(char *));unsigned long *lengths=(unsigned long *)calloc((size_t)count+1,sizeof(unsigned long));
    if(!params||!values||!lengths)fail("Memoria insufficiente");
    for(int i=0;i<count;++i){values[i]=parameter_text(required_field(payload,cJSON_GetArrayItem(fields,i)->valuestring));if(values[i]){lengths[i]=(unsigned long)strlen(values[i]);params[i].buffer_type=MYSQL_TYPE_STRING;params[i].buffer=values[i];params[i].buffer_length=lengths[i];params[i].length=&lengths[i];}else params[i].buffer_type=MYSQL_TYPE_NULL;}
    if(count&&mysql_stmt_bind_param(statement,params))fail(mysql_stmt_error(statement));
    int execution=mysql_stmt_execute(statement);for(int i=0;i<count;++i)free(values[i]);free(values);free(params);free(lengths);if(execution)fail(mysql_stmt_error(statement));
    cJSON *result=cJSON_CreateArray();
    MYSQL_RES *metadata=mysql_stmt_result_metadata(statement);
    if(metadata){OWN(metadata,mysql_free_result);unsigned int columns=mysql_num_fields(metadata);MYSQL_FIELD *names=mysql_fetch_fields(metadata);MYSQL_BIND *bindings=(MYSQL_BIND *)calloc(columns,sizeof(MYSQL_BIND));unsigned long *sizes=(unsigned long *)calloc(columns,sizeof(unsigned long));my_bool *nulls=(my_bool *)calloc(columns,sizeof(my_bool));my_bool *errors=(my_bool *)calloc(columns,sizeof(my_bool));
        if(!bindings||!sizes||!nulls||!errors)fail("Memoria insufficiente");
        for(unsigned int i=0;i<columns;++i){bindings[i].buffer_type=MYSQL_TYPE_STRING;bindings[i].length=&sizes[i];bindings[i].is_null=&nulls[i];bindings[i].error=&errors[i];}
        if(mysql_stmt_bind_result(statement,bindings))fail(mysql_stmt_error(statement));
        int status;while((status=mysql_stmt_fetch(statement))==0||status==MYSQL_DATA_TRUNCATED){if(cJSON_GetArraySize(result)>=100)break;cJSON *record=cJSON_CreateObject();for(unsigned int i=0;i<columns;++i){if(nulls[i]){cJSON_AddNullToObject(record,names[i].name);continue;}char *buffer=(char *)calloc((size_t)sizes[i]+1,1);if(!buffer)fail("Memoria insufficiente");MYSQL_BIND field;memset(&field,0,sizeof(field));field.buffer_type=MYSQL_TYPE_STRING;field.buffer=buffer;field.buffer_length=sizes[i]+1;if(mysql_stmt_fetch_column(statement,&field,i,0))fail(mysql_stmt_error(statement));cJSON_AddStringToObject(record,names[i].name,buffer);free(buffer);}cJSON_AddItemToArray(result,record);}
        if(status!=0&&status!=MYSQL_NO_DATA&&status!=MYSQL_DATA_TRUNCATED)fail(mysql_stmt_error(statement));free(bindings);free(sizes);free(nulls);free(errors);CLEAN(metadata,mysql_free_result);
    }else{cJSON_Delete(result);result=cJSON_CreateObject();char affected[32];snprintf(affected,sizeof(affected),"%llu",(unsigned long long)mysql_stmt_affected_rows(statement));cJSON_AddStringToObject(result,"affected",affected);}
    CLEAN(statement,mysql_stmt_close);CLEAN(connection,mysql_close);return result;
}
"#;
    let mongodb = r#"
static cJSON *database_operation(const char *operation,cJSON *payload,const char *sql,cJSON *fields) {
    (void)sql;(void)fields;const char *url=getenv("DATABASE_URL");if(!url)fail("Impostare DATABASE_URL");
    mongoc_client_t *client=mongoc_client_new(url);if(!client)fail("URI MongoDB non valido");OWN(client,mongoc_client_destroy);
    mongoc_collection_t *collection=mongoc_client_get_collection(client,getenv("DATABASE_NAME")?getenv("DATABASE_NAME"):"database",TABLE);OWN(collection,mongoc_collection_destroy);
    bson_error_t error;char *raw=cJSON_PrintUnformatted(payload);bson_t *document=bson_new_from_json((const uint8_t *)raw,-1,&error);cJSON_free(raw);if(!document)fail(error.message);OWN(document,bson_destroy);
    cJSON *result=cJSON_CreateArray();
    if(!strcmp(operation,"list")){
        bson_t *filter=bson_new_from_json((const uint8_t *)FILTER,-1,&error);if(!filter)fail(error.message);OWN(filter,bson_destroy);
        bson_t *options=BCON_NEW("limit",BCON_INT64(100));OWN(options,bson_destroy);
        mongoc_cursor_t *cursor=mongoc_collection_find_with_opts(collection,filter,options,NULL);OWN(cursor,mongoc_cursor_destroy);const bson_t *row;
        while(mongoc_cursor_next(cursor,&row)){char *text=bson_as_canonical_extended_json(row,NULL);cJSON *value=cJSON_Parse(text);bson_free(text);if(!value)fail("Serializzazione BSON non riuscita");cJSON_AddItemToArray(result,value);}
        if(mongoc_cursor_error(cursor,&error))fail(error.message);CLEAN(cursor,mongoc_cursor_destroy);CLEAN(options,bson_destroy);CLEAN(filter,bson_destroy);
    }else{
        bson_t reply;bool ok=false;
        if(!strcmp(operation,"insert"))ok=mongoc_collection_insert_one(collection,document,NULL,&reply,&error);
        else{
            bson_iter_t id;if(!bson_iter_init_find(&id,document,"_id"))fail("Manca _id in Extended JSON");
            bson_t *filter=bson_new();OWN(filter,bson_destroy);bson_append_value(filter,"_id",-1,bson_iter_value(&id));
            if(!strcmp(operation,"delete"))ok=mongoc_collection_delete_one(collection,filter,NULL,&reply,&error);
            else if(!strcmp(operation,"update")){
                bson_t *values=bson_new();OWN(values,bson_destroy);bson_iter_t iterator;bson_iter_init(&iterator,document);while(bson_iter_next(&iterator))if(strcmp(bson_iter_key(&iterator),"_id"))bson_append_value(values,bson_iter_key(&iterator),-1,bson_iter_value(&iterator));
                if(bson_empty(values))fail("Nessun campo da aggiornare");bson_t *update=bson_new();OWN(update,bson_destroy);bson_append_document(update,"$set",-1,values);ok=mongoc_collection_update_one(collection,filter,update,NULL,&reply,&error);CLEAN(update,bson_destroy);CLEAN(values,bson_destroy);
            }else fail("Operazione sconosciuta");CLEAN(filter,bson_destroy);
        }
        cJSON_Delete(result);if(!ok){bson_destroy(&reply);fail(error.message);}char *text=bson_as_canonical_extended_json(&reply,NULL);result=cJSON_Parse(text);bson_free(text);bson_destroy(&reply);
    }
    CLEAN(document,bson_destroy);CLEAN(collection,mongoc_collection_destroy);CLEAN(client,mongoc_client_destroy);return result;
}
"#;
    let body = match ctx.req.engine.as_str() {
        "sqlite" => sqlite,
        "postgresql" => postgres,
        "mongodb" => mongodb,
        _ => mysql,
    };
    let ctxp = ctx.placeholders(if ctx.req.engine == "postgresql" {
        "numbered"
    } else {
        "?"
    });
    let constants=format!("static const int DOCUMENT_ENGINE = {};\nstatic const char *TABLE = {};\nstatic const char *FILTER = {};\nstatic const char *QUERY = {};\nstatic const char *INSERT_SQL = {};\nstatic const char *UPDATE_SQL = {};\nstatic const char *DELETE_SQL = {};\nstatic const char *COLUMNS_JSON = {};\nstatic const char *KEYS_JSON = {};\nstatic const char *NONKEYS_JSON = {};\n",if ctx.req.engine=="mongodb"{1}else{0},literal(&ctx.req.table),literal(&ctx.filter.to_string()),literal(&ctx.select),literal(&ctxp.insert),literal(&ctxp.update),literal(&ctxp.delete),literal(&json!(ctx.columns).to_string()),literal(&json!(ctx.keys).to_string()),literal(&json!(ctx.nonkeys).to_string()));
    let init = if ctx.req.engine == "mongodb" {
        "mongoc_init();"
    } else {
        ""
    };
    let cleanup = if ctx.req.engine == "mongodb" {
        "mongoc_cleanup();"
    } else {
        ""
    };
    let source = format!(
        r#"#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdbool.h>
#include <cjson/cJSON.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#endif
{headers}
#ifdef __cplusplus
#include <memory>
#include <type_traits>
#include <stdexcept>
#define OWN(pointer, deleter) auto pointer##_owner = std::unique_ptr<typename std::remove_pointer<decltype(pointer)>::type, decltype(&deleter)>(pointer, &deleter)
#define CLEAN(pointer, deleter) ((void)0)
static void fail(const char *message) {{ throw std::runtime_error(message); }}
#else
#define OWN(pointer, deleter) ((void)0)
#define CLEAN(pointer, deleter) deleter(pointer)
static void fail(const char *message) {{ fprintf(stderr,"%s\n",message); exit(1); }}
#endif
{constants}
static cJSON *required_field(cJSON *payload,const char *name) {{ cJSON *value=cJSON_GetObjectItemCaseSensitive(payload,name);if(!value)fail("Campo richiesto mancante");return value; }}
static void exact_number(cJSON *value) {{ if(fabs(value->valuedouble)>9007199254740991.0)fail("Usare una stringa per interi oltre 2^53: il parser JSON C usa double"); }}
static char *parameter_text(cJSON *value) {{ if(cJSON_IsNull(value))return NULL;if(cJSON_IsNumber(value))exact_number(value);const char *string=cJSON_IsString(value)?value->valuestring:NULL;char *raw=string?NULL:cJSON_PrintUnformatted(value);if(cJSON_IsBool(value)){{if(raw)cJSON_free(raw);raw=NULL;string=cJSON_IsTrue(value)?"1":"0";}}const char *source=string?string:raw;char *copy=(char *)malloc(strlen(source)+1);if(!copy)fail("Memoria insufficiente");strcpy(copy,source);if(raw)cJSON_free(raw);return copy; }}
{body}
static int run(int argc,char **argv) {{
    const char *operation=argc>1?argv[1]:"list";
    cJSON *payload=cJSON_Parse(argc>2?argv[2]:"{{}}");if(!payload||!cJSON_IsObject(payload))fail("Payload deve essere oggetto JSON");OWN(payload,cJSON_Delete);
    cJSON *fields=cJSON_CreateArray();OWN(fields,cJSON_Delete);const char *sql=QUERY;
    if(!strcmp(operation,"insert")){{sql=INSERT_SQL;cJSON *names=cJSON_Parse(COLUMNS_JSON);cJSON *name;cJSON_ArrayForEach(name,names)cJSON_AddItemToArray(fields,cJSON_Duplicate(name,1));cJSON_Delete(names);}}
    else if(!strcmp(operation,"update")||!strcmp(operation,"delete")){{sql=!strcmp(operation,"update")?UPDATE_SQL:DELETE_SQL;if(!strcmp(operation,"update")){{cJSON *names=cJSON_Parse(NONKEYS_JSON);cJSON *name;cJSON_ArrayForEach(name,names)cJSON_AddItemToArray(fields,cJSON_Duplicate(name,1));cJSON_Delete(names);}}cJSON *names=cJSON_Parse(KEYS_JSON);cJSON *name;cJSON_ArrayForEach(name,names)cJSON_AddItemToArray(fields,cJSON_Duplicate(name,1));cJSON_Delete(names);}}
    else if(strcmp(operation,"list"))fail("Operazione sconosciuta");
    if(!DOCUMENT_ENGINE&&!sql[0])fail("Operazione non disponibile");{init}
    cJSON *result=database_operation(operation,payload,sql,fields);OWN(result,cJSON_Delete);char *text=cJSON_PrintUnformatted(result);if(!text)fail("Serializzazione non riuscita");puts(text);cJSON_free(text);{cleanup}
    CLEAN(result,cJSON_Delete);CLEAN(fields,cJSON_Delete);CLEAN(payload,cJSON_Delete);return 0;
}}
int main(int argc,char **argv) {{
#ifdef _WIN32
    int wide_count=0;LPWSTR *wide_values=CommandLineToArgvW(GetCommandLineW(),&wide_count);
    if(!wide_values)return 1;
    char **utf8_values=(char **)calloc((size_t)wide_count+1,sizeof(char *));if(!utf8_values){{LocalFree(wide_values);return 1;}}
    for(int index=0;index<wide_count;++index){{int size=WideCharToMultiByte(CP_UTF8,0,wide_values[index],-1,NULL,0,NULL,NULL);utf8_values[index]=(char *)calloc((size_t)size,1);if(!utf8_values[index])return 1;WideCharToMultiByte(CP_UTF8,0,wide_values[index],-1,utf8_values[index],size,NULL,NULL);}}
    LocalFree(wide_values);argc=wide_count;argv=utf8_values;
#endif
    int status;
#ifdef __cplusplus
    try {{ status=run(argc,argv); }} catch(const std::exception &error) {{ fprintf(stderr,"%s\n",error.what());status=1; }}
#else
    status=run(argc,argv);
#endif
#ifdef _WIN32
    for(int index=0;index<wide_count;++index)free(utf8_values[index]);free(utf8_values);
#endif
    return status;
}}
"#
    );
    let ext = if cpp { "cpp" } else { "c" };
    let cmake=format!("cmake_minimum_required(VERSION 3.24)\nproject(DatabaseExample LANGUAGES {})\nset(CMAKE_{}_STANDARD {})\nadd_executable(database_example main.{ext})\nfind_package(cJSON CONFIG REQUIRED)\n{packages}\ntarget_link_libraries(database_example PRIVATE cjson {links})\nif(WIN32)\n  target_link_libraries(database_example PRIVATE shell32)\nendif()\n",if cpp{"CXX"}else{"C"},if cpp{"CXX"}else{"C"},if cpp{"20"}else{"11"});
    let mut files = vec![
        file("CMakeLists.txt", cmake),
        file(
            "vcpkg.json",
            json!({"name":"database-example","version-string":"1.0.0","dependencies":ports})
                .to_string(),
        ),
    ];
    if matches!(ctx.req.engine.as_str(), "mysql" | "mariadb") {
        files.push(file("MYSQL-ENV.md","# Variabili del driver nativo\n\nIl driver C MariaDB usa `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, anziché DATABASE_URL. Impostarle nel terminale, senza inserirle nei sorgenti. Se l'installazione del connector separa i plugin di autenticazione, impostare `DB_PLUGIN_DIR` alla cartella che contiene caching_sha2_password.dll e gli altri plugin. Compilare driver e progetto con lo stesso toolchain/architettura.\n"));
    }
    Ok(Template{source,path:format!("main.{ext}"),files,command:"cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=\"$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake\"; cmake --build build --config Release; ./build/Release/database_example.exe list".into(),dependencies:"CMake + vcpkg + driver nativo + cJSON. PostgreSQL/MySQL restituiscono i valori numerici come stringhe esatte; interi JSON oltre 2^53 devono essere forniti come stringhe.".into()})
}
