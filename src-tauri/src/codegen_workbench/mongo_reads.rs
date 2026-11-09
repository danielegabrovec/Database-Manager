use super::*;
pub(super) fn generate(request: &WorkbenchRequest) -> Result<GeneratedProject, String> {
    let mut request = request.clone();
    let mut input = if request.query.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&request.query)
            .map_err(|e| format!("Filtro/pipeline MongoDB JSON non valido: {e}"))?
    };
    if request.operation == "findByKey" && request.query.trim().is_empty() {
        if !request.parameters.is_empty() {
            return Err(
                "Per parametri MongoDB personalizzati fornire il filtro con marker $param.".into(),
            );
        }
        request.parameters.push(WorkbenchParameter {
            name: "p1".into(),
            data_type: request
                .columns
                .iter()
                .find(|c| c.name == "_id" || c.primary_key)
                .map(|c| c.data_type.clone())
                .unwrap_or("objectid".into()),
            nullable: false,
            value: None,
        });
        input = json!({"_id":{"$eq":{"$param":"p1"}}});
    }
    if !input.is_object() {
        return Err(
            "MongoDB richiede un filtro oggetto o un comando aggregate con pipeline.".into(),
        );
    }
    let aggregate = input.get("aggregate").is_some() && input.get("pipeline").is_some();
    let template = if aggregate {
        if !input["pipeline"].is_array() {
            return Err("pipeline deve essere un array.".into());
        }
        json!({"pipeline":input["pipeline"]})
    } else if input.get("find").is_some() && input.get("filter").is_some() {
        if !input["filter"].is_object() {
            return Err("filter deve essere un oggetto.".into());
        }
        let mut options = json!({"limit":100});
        for key in ["limit", "skip", "sort", "projection"] {
            if let Some(v) = input.get(key) {
                options[key] = v.clone();
            }
        }
        json!({"filter":input["filter"],"options":options})
    } else {
        json!({"filter":input,"options":{"limit":100}})
    };
    let mut references = HashSet::new();
    collect_markers(&template, &mut references)?;
    let declared = request
        .parameters
        .iter()
        .map(|p| p.name.as_str())
        .collect::<HashSet<_>>();
    if references
        .iter()
        .any(|name| !declared.contains(name.as_str()))
        || declared.iter().any(|name| !references.contains(*name))
    {
        return Err("I marker MongoDB {\"$param\":\"nome\"} devono corrispondere esattamente ai parametri dichiarati.".into());
    }
    let text = serde_json::to_string(&template).unwrap();
    let pairs = vec![
        ("@@TEMPLATE@@", literal(&text)),
        ("@@SINGLE_TEMPLATE@@", single_literal(&text)),
        (
            "@@AGGREGATE@@",
            if aggregate { "true" } else { "false" }.into(),
        ),
    ];
    let source = match request.language.as_str() {
        "python" => super::render(
            r#"import json
from bson import json_util

TEMPLATE = @@TEMPLATE@@
def _bind(value, parameters):
    if isinstance(value, dict):
        if set(value) == {'$param'}:
            name = value['$param']
            if name not in parameters: raise ValueError('Parametro mancante: ' + name)
            return parameters[name]
        return {key: _bind(item, parameters) for key, item in value.items()}
    if isinstance(value, list): return [_bind(item, parameters) for item in value]
    return value

def read_records(collection, parameters=None):
    bound = _bind(json_util.loads(TEMPLATE), {} if parameters is None else parameters)
    if 'pipeline' in bound: return list(collection.aggregate(bound['pipeline']))
    options = bound.get('options', {})
    return list(collection.find(bound['filter'], **options))
"#,
            &pairs,
        ),
        "javascript" | "typescript" => {
            let ts = request.language == "typescript";
            format!("import {{ BSON{} }} from 'mongodb';\n{}const TEMPLATE = {};\nfunction bind(value{}, parameters{}){} {{\n  if (Array.isArray(value)) return value.map(item => bind(item, parameters));\n  if (value && typeof value === 'object') {{\n    if (Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, '$param')) {{\n      if (!Object.prototype.hasOwnProperty.call(parameters, value.$param)) throw new Error('Parametro mancante: ' + value.$param);\n      return parameters[value.$param];\n    }}\n    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, parameters)]));\n  }}\n  return value;\n}}\nexport async function readRecords(collection{}, parameters{} = {{}}){} {{\n  const canonicalParameters = BSON.EJSON.serialize(parameters);\n  const bound = BSON.EJSON.deserialize(bind(JSON.parse(TEMPLATE), canonicalParameters));\n  return bound.pipeline ? collection.aggregate(bound.pipeline).toArray() : collection.find(bound.filter, bound.options).toArray();\n}}\n",if ts{", type Collection, type Document"}else{""},if ts{"type ReadConnection = Collection<Document>;\n"}else{""},literal(&text),if ts{": any"}else{""},if ts{": Record<string, any>"}else{""},if ts{": any"}else{""},if ts{": ReadConnection"}else{""},if ts{": Record<string, any>"}else{""},if ts{": Promise<Document[]>"}else{""})
        }
        "rust" => super::render(
            r#"use mongodb::{bson::{self, Bson, Document}, Collection};
use futures_util::TryStreamExt;
pub type ReadError = Box<dyn std::error::Error + Send + Sync>;

fn bind(value: Bson, parameters: &Document) -> Result<Bson, ReadError> {
    match value {
        Bson::Document(document) if document.len() == 1 && document.contains_key("$param") => {
            let name = document.get_str("$param")?;
            Ok(parameters.get(name).ok_or_else(||format!("Parametro mancante: {name}"))?.clone())
        }
        Bson::Document(document) => Ok(Bson::Document(document.into_iter().map(|(key,value)| Ok((key,bind(value,parameters)?))).collect::<Result<Document,ReadError>>()?)),
        Bson::Array(values) => Ok(Bson::Array(values.into_iter().map(|value|bind(value,parameters)).collect::<Result<Vec<_>,_>>()?)),
        value => Ok(value),
    }
}
pub async fn read_records(collection: &Collection<Document>, parameters: &Document) -> Result<Vec<Document>, ReadError> {
    let template = Bson::try_from(serde_json::from_str::<serde_json::Value>(@@TEMPLATE@@)?)?;
    let bound = bind(template,parameters)?;
    let command = bound.as_document().ok_or("Comando MongoDB non valido")?;
    if let Ok(pipeline) = command.get_array("pipeline") {
        let pipeline = pipeline.iter().map(|stage|stage.as_document().cloned().ok_or("Stage pipeline non valido")).collect::<Result<Vec<_>,_>>()?;
        return Ok(collection.aggregate(pipeline).await?.try_collect().await?);
    }
    let mut action = collection.find(command.get_document("filter")?.clone());
    if let Ok(options) = command.get_document("options") {
        if let Some(value) = options.get("limit").and_then(|v|v.as_i64().or_else(||v.as_i32().map(i64::from))) { action = action.limit(value); }
        if let Some(value) = options.get("skip").and_then(|v|v.as_i64().or_else(||v.as_i32().map(i64::from))) { if value < 0 { return Err("skip negativo".into()); } action=action.skip(value as u64); }
        if let Ok(value)=options.get_document("sort") { action=action.sort(value.clone()); }
        if let Ok(value)=options.get_document("projection") { action=action.projection(value.clone()); }
    }
    Ok(action.await?.try_collect().await?)
}
"#,
            &pairs,
        ),
        "java" => super::render(
            r#"import com.mongodb.client.MongoCollection;
import org.bson.*;
import java.util.*;

public final class ReadRecords {
    private static BsonValue bind(BsonValue value, Map<String,BsonValue> parameters) {
        if(value.isDocument()) {
            BsonDocument document=value.asDocument();
            if(document.size()==1 && document.containsKey("$param")) { String name=document.getString("$param").getValue(); if(!parameters.containsKey(name)) throw new IllegalArgumentException("Parametro mancante: "+name); return parameters.get(name); }
            BsonDocument result=new BsonDocument(); document.forEach((key,item)->result.put(key,bind(item,parameters))); return result;
        }
        if(value.isArray()) { BsonArray result=new BsonArray(); for(BsonValue item:value.asArray()) result.add(bind(item,parameters)); return result; }
        return value;
    }
    public static List<Document> readRecords(MongoCollection<Document> collection, Map<String,BsonValue> parameters) {
        BsonDocument command=bind(BsonDocument.parse(@@TEMPLATE@@),parameters).asDocument();
        if(command.containsKey("pipeline")) { List<BsonDocument> pipeline=new ArrayList<>(); for(BsonValue stage:command.getArray("pipeline")) pipeline.add(stage.asDocument()); return collection.aggregate(pipeline).into(new ArrayList<>()); }
        var query=collection.find(command.getDocument("filter")); BsonDocument options=command.getDocument("options",new BsonDocument());
        if(options.containsKey("limit")) query=query.limit(options.getNumber("limit").intValue()); if(options.containsKey("skip")) query=query.skip(options.getNumber("skip").intValue());
        if(options.containsKey("sort")) query=query.sort(options.getDocument("sort")); if(options.containsKey("projection")) query=query.projection(options.getDocument("projection"));
        return query.into(new ArrayList<>());
    }
}
"#,
            &pairs,
        ),
        "kotlin" => super::render(
            r#"import com.mongodb.client.MongoCollection
import org.bson.*

private fun bind(value: BsonValue, parameters: Map<String,BsonValue>): BsonValue {
    if(value.isDocument) {
        val document=value.asDocument()
        if(document.size==1 && document.containsKey("\$param")) return parameters[document.getString("\$param").value] ?: error("Parametro mancante")
        val result=BsonDocument(); document.forEach { key,item -> result[key]=bind(item,parameters) }; return result
    }
    if(value.isArray) return BsonArray(value.asArray().values.map { bind(it,parameters) })
    return value
}
fun readRecords(collection: MongoCollection<Document>, parameters: Map<String,BsonValue> = emptyMap()): List<Document> {
    val command=bind(BsonDocument.parse(@@KOTLIN_TEMPLATE@@),parameters).asDocument()
    if(command.containsKey("pipeline")) return collection.aggregate(command.getArray("pipeline").map { it.asDocument() }).toList()
    var query=collection.find(command.getDocument("filter")); val options=command.getDocument("options",BsonDocument())
    if(options.containsKey("limit")) query=query.limit(options.getNumber("limit").intValue()); if(options.containsKey("skip")) query=query.skip(options.getNumber("skip").intValue())
    if(options.containsKey("sort")) query=query.sort(options.getDocument("sort")); if(options.containsKey("projection")) query=query.projection(options.getDocument("projection"))
    return query.toList()
}
"#,
            &[("@@KOTLIN_TEMPLATE@@", literal(&text).replace('$', "\\$"))],
        ),
        "csharp" => super::render(
            r#"using MongoDB.Bson;
using MongoDB.Driver;
using System;
using System.Linq;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

public static class DatabaseReadQueries {
    private static BsonValue Bind(BsonValue value,IReadOnlyDictionary<string,BsonValue> parameters) {
        if(value.IsBsonDocument) { var document=value.AsBsonDocument;
            if(document.ElementCount==1 && document.Contains("$param")) { var name=document["$param"].AsString; return parameters.TryGetValue(name,out var replacement) ? replacement : throw new ArgumentException("Parametro mancante: "+name); }
            return new BsonDocument(document.Elements.Select(e=>new BsonElement(e.Name,Bind(e.Value,parameters))));
        }
        if(value.IsBsonArray) return new BsonArray(value.AsBsonArray.Select(v=>Bind(v,parameters)));
        return value;
    }
    public static async Task<List<BsonDocument>> ReadRecordsAsync(IMongoCollection<BsonDocument> collection,IReadOnlyDictionary<string,BsonValue> parameters,CancellationToken cancellationToken=default) {
        var command=Bind(BsonDocument.Parse(@@TEMPLATE@@),parameters).AsBsonDocument;
        if(command.Contains("pipeline")) return await collection.Aggregate<BsonDocument>(command["pipeline"].AsBsonArray.Select(v=>v.AsBsonDocument).ToArray()).ToListAsync(cancellationToken);
        var query=collection.Find(command["filter"].AsBsonDocument);var options=command.GetValue("options",new BsonDocument()).AsBsonDocument;
        if(options.Contains("limit")) query=query.Limit(options["limit"].ToInt32());if(options.Contains("skip")) query=query.Skip(options["skip"].ToInt32());
        if(options.Contains("sort")) query=query.Sort(options["sort"].AsBsonDocument);if(options.Contains("projection")) query=query.Project<BsonDocument>(options["projection"].AsBsonDocument);
        return await query.ToListAsync(cancellationToken);
    }
}
"#,
            &pairs,
        ),
        "php" => super::render(
            r#"<?php
declare(strict_types=1);
namespace DatabaseWorkbench;

function bind_filter(mixed $value,array $parameters): mixed {
    if(is_array($value)) { if(count($value)===1 && array_key_exists('$param',$value)) { $name=$value['$param']; if(!array_key_exists($name,$parameters)) throw new \InvalidArgumentException('Parametro mancante: '.$name); return $parameters[$name]; }
        foreach($value as $key=>$item) $value[$key]=bind_filter($item,$parameters);
    }
    return $value;
}
function read_records(\MongoDB\Collection $collection,array $parameters=[]): array {
    $template=\MongoDB\BSON\Document::fromJSON(@@SINGLE_TEMPLATE@@)->toPHP(['root'=>'array','document'=>'array','array'=>'array']);
    $command=bind_filter($template,$parameters);
    $cursor=array_key_exists('pipeline',$command) ? $collection->aggregate($command['pipeline']) : $collection->find($command['filter'],$command['options'] ?? []);
    return iterator_to_array($cursor,false);
}
"#,
            &pairs,
        ),
        "ruby" => super::render(
            r#"require 'bson'
module DatabaseWorkbench
    TEMPLATE = @@SINGLE_TEMPLATE@@.freeze
    def self.bind_filter(value, parameters)
        if value.is_a?(Hash)
            return parameters.fetch(value['$param']) if value.keys==['$param']
            return value.transform_values { |item| bind_filter(item,parameters) }
        end
        return value.map { |item| bind_filter(item,parameters) } if value.is_a?(Array)
        value
    end
    def self.read_records(collection, parameters={})
        command=bind_filter(BSON::ExtJSON.parse(TEMPLATE),parameters)
        return collection.aggregate(command['pipeline']).to_a if command.key?('pipeline')
        options=command.fetch('options',{}).transform_keys(&:to_sym)
        collection.find(command['filter'],options).to_a
    end
end
"#,
            &pairs,
        ),
        "go" => super::render(
            r#"package workbench
import (
 "context"
 "fmt"
 "go.mongodb.org/mongo-driver/v2/bson"
 "go.mongodb.org/mongo-driver/v2/mongo"
 "go.mongodb.org/mongo-driver/v2/mongo/options"
)
func bindFilter(value any, parameters map[string]any) (any,error) {
 switch value:=value.(type) {
 case bson.D:
  if len(value)==1 && value[0].Key=="$param" { name,ok:=value[0].Value.(string); if !ok{return nil,fmt.Errorf("marker non valido")}; replacement,ok:=parameters[name];if !ok{return nil,fmt.Errorf("parametro mancante: %s",name)};return replacement,nil }
  result:=bson.D{};for _,element:=range value{bound,err:=bindFilter(element.Value,parameters);if err!=nil{return nil,err};result=append(result,bson.E{Key:element.Key,Value:bound})};return result,nil
 case bson.A:
  result:=bson.A{};for _,item:=range value{bound,err:=bindFilter(item,parameters);if err!=nil{return nil,err};result=append(result,bound)};return result,nil
 default:return value,nil
 }
}
func ReadRecords(ctx context.Context, collection *mongo.Collection, parameters map[string]any) ([]bson.M,error) {
 var template bson.D;if err:=bson.UnmarshalExtJSON([]byte(@@TEMPLATE@@),true,&template);err!=nil{return nil,err}
 bound,err:=bindFilter(template,parameters);if err!=nil{return nil,err};document:=bound.(bson.D);command:=bson.M{};for _,element:=range document{command[element.Key]=element.Value}
 var cursor *mongo.Cursor
 if pipeline,ok:=command["pipeline"];ok {cursor,err=collection.Aggregate(ctx,pipeline)} else {
  settings:=options.Find();if raw,ok:=command["options"].(bson.D);ok{for _,element:=range raw{switch element.Key{case "limit":switch n:=element.Value.(type){case int32:settings.SetLimit(int64(n));case int64:settings.SetLimit(n)};case "skip":switch n:=element.Value.(type){case int32:settings.SetSkip(int64(n));case int64:settings.SetSkip(n)};case "sort":settings.SetSort(element.Value);case "projection":settings.SetProjection(element.Value)}}}
  cursor,err=collection.Find(ctx,command["filter"],settings)
 }
 if err!=nil{return nil,err};defer cursor.Close(ctx);result:=[]bson.M{};if err=cursor.All(ctx,&result);err!=nil{return nil,err};return result,nil
}
"#,
            &pairs,
        ),
        "c" | "cpp" => c_mongo(&text),
        _ => unreachable!(),
    };
    let mut project = super::package(
        &request,
        source,
        &QueryPlan {
            sql: text.clone(),
            bindings: request.parameters.clone(),
        },
    )?;
    for item in &mut project.files {
        if item.path == "workbench/query.sql" {
            item.path = "workbench/mongodb-query.json".into();
            item.content = serde_json::to_string_pretty(&template).unwrap();
        }
    }
    project.notes.push("MongoDB usa documenti BSON/Extended JSON e marker {$param:nome}, senza interpolare testo. I parametri passati alla funzione sono valori BSON nativi. Nei filtri utente usare $eq per uguaglianze e $literal nelle espressioni di aggregazione.".into());
    Ok(project)
}
fn collect_markers(value: &Value, names: &mut HashSet<String>) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if object.len() == 1 && object.contains_key("$param") {
                names.insert(
                    object["$param"]
                        .as_str()
                        .ok_or("Il marker $param richiede un nome stringa.")?
                        .into(),
                );
            } else {
                for value in object.values() {
                    collect_markers(value, names)?;
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_markers(value, names)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn repository(request: &WorkbenchRequest) -> String {
    match request.language.as_str(){
    "python"=>"\nclass RecordRepository:\n    def __init__(self, collection): self.collection=collection\n    def read(self, parameters=None): return read_records(self.collection,parameters)\n".into(),
    "javascript"=>"\nexport class RecordRepository { constructor(collection){this.collection=collection;} read(parameters={}){return readRecords(this.collection,parameters);} }\n".into(),
    "typescript"=>"\nexport class RecordRepository { constructor(private readonly collection:ReadConnection){} read(parameters:Record<string,any>={}){return readRecords(this.collection,parameters);} }\n".into(),
    "java"=>"\nfinal class RecordRepository { private final MongoCollection<Document> collection; public RecordRepository(MongoCollection<Document> collection){this.collection=collection;} public List<Document> read(Map<String,BsonValue> parameters){return ReadRecords.readRecords(collection,parameters);} }\n".into(),
    "kotlin"=>"\nclass RecordRepository(private val collection:MongoCollection<Document>){fun read(parameters:Map<String,BsonValue> = emptyMap()):List<Document> = readRecords(collection,parameters)}\n".into(),
    "csharp"=>"\npublic sealed class RecordRepository { private readonly IMongoCollection<BsonDocument> collection; public RecordRepository(IMongoCollection<BsonDocument> collection){this.collection=collection;} public Task<List<BsonDocument>> ReadAsync(IReadOnlyDictionary<string,BsonValue> parameters,CancellationToken cancellationToken=default)=>DatabaseReadQueries.ReadRecordsAsync(collection,parameters,cancellationToken); }\n".into(),
    "php"=>"\nfinal class RecordRepository { public function __construct(private \\MongoDB\\Collection $collection){} public function read(array $parameters=[]):array{return read_records($this->collection,$parameters);} }\n".into(),
    "ruby"=>"\nmodule DatabaseWorkbench;class RecordRepository;def initialize(collection);@collection=collection;end;def read(parameters={});DatabaseWorkbench.read_records(@collection,parameters);end;end;end\n".into(),
    "go"=>"\ntype RecordRepository struct{Collection *mongo.Collection}\nfunc(repository *RecordRepository) Read(ctx context.Context,parameters map[string]any)([]bson.M,error){return ReadRecords(ctx,repository.Collection,parameters)}\n".into(),
    "rust"=>"\npub struct RecordRepository<'a>{pub collection:&'a Collection<Document>}\nimpl RecordRepository<'_>{pub async fn read(&self,parameters:&Document)->Result<Vec<Document>,ReadError>{read_records(self.collection,parameters).await}}\n".into(),
    "cpp"=>"\nclass RecordRepository{mongoc_collection_t *collection_;public:explicit RecordRepository(mongoc_collection_t *collection):collection_(collection){} int64_t read(const bson_t *parameters,DbmBsonRow callback,void *context) const{return read_records(collection_,parameters,callback,context);}};\n".into(),
    _=>"\ntypedef struct{mongoc_collection_t *collection;} RecordRepository;\nstatic inline int64_t record_repository_read(RecordRepository *repository,const bson_t *parameters,DbmBsonRow callback,void *context){return read_records(repository->collection,parameters,callback,context);}\n".into(),
}
}
fn c_mongo(template: &str) -> String {
    super::render(
        r#"#pragma once
#include <mongoc/mongoc.h>
#include <bson/bson.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
typedef void (*DbmBsonRow)(const bson_t *document,void *context);
static bool dbm_bind_document(const bson_t *input,const bson_t *parameters,bson_t *output){
 bson_iter_t item;if(!bson_iter_init(&item,input))return false;
 while(bson_iter_next(&item)){
  const char *key=bson_iter_key(&item);const bson_value_t *value=bson_iter_value(&item);
  if(BSON_ITER_HOLDS_DOCUMENT(&item)||BSON_ITER_HOLDS_ARRAY(&item)){
   const uint8_t *data;uint32_t length;bson_t nested;bson_iter_t marker;
   if(BSON_ITER_HOLDS_ARRAY(&item))bson_iter_array(&item,&length,&data);else bson_iter_document(&item,&length,&data);
   if(!bson_init_static(&nested,data,length))return false;
   if(bson_count_keys(&nested)==1&&bson_iter_init_find(&marker,&nested,"$param")&&BSON_ITER_HOLDS_UTF8(&marker)){
    const char *name=bson_iter_utf8(&marker,NULL);bson_iter_t parameter;if(!bson_iter_init_find(&parameter,parameters,name)||!bson_append_value(output,key,-1,bson_iter_value(&parameter)))return false;
   }else{bson_t bound;bson_init(&bound);if(!dbm_bind_document(&nested,parameters,&bound)){bson_destroy(&bound);return false;}bool ok=BSON_ITER_HOLDS_ARRAY(&item)?bson_append_array(output,key,-1,&bound):bson_append_document(output,key,-1,&bound);bson_destroy(&bound);if(!ok)return false;}
  }else if(!bson_append_value(output,key,-1,value))return false;
 }
 return true;
}
static int64_t read_records(mongoc_collection_t *collection,const bson_t *parameters,DbmBsonRow callback,void *context){
 bson_error_t error;bson_t *input=bson_new_from_json((const uint8_t *)@@TEMPLATE@@,-1,&error);bson_t bound,options,filter;const uint8_t *data;uint32_t length;bson_iter_t item;mongoc_cursor_t *cursor=NULL;const bson_t *row;int64_t count=0;
 if(!input||!parameters||!callback){if(input)bson_destroy(input);return -1;}bson_init(&bound);bson_init(&options);
 if(!dbm_bind_document(input,parameters,&bound)){bson_destroy(input);bson_destroy(&bound);bson_destroy(&options);return -1;}bson_destroy(input);
 if(bson_iter_init_find(&item,&bound,"pipeline")){cursor=mongoc_collection_aggregate(collection,MONGOC_QUERY_NONE,&bound,&options,NULL);}else{
  if(!bson_iter_init_find(&item,&bound,"filter")||!BSON_ITER_HOLDS_DOCUMENT(&item)){bson_destroy(&bound);bson_destroy(&options);return -1;}
  bson_iter_document(&item,&length,&data);bson_init_static(&filter,data,length);
  if(bson_iter_init_find(&item,&bound,"options")&&BSON_ITER_HOLDS_DOCUMENT(&item)){bson_iter_document(&item,&length,&data);bson_destroy(&options);bson_init_static(&options,data,length);}
  cursor=mongoc_collection_find_with_opts(collection,&filter,&options,NULL);
 }
 while(mongoc_cursor_next(cursor,&row)){callback(row,context);count++;}bool failed=mongoc_cursor_error(cursor,&error);mongoc_cursor_destroy(cursor);bson_destroy(&options);bson_destroy(&bound);return failed?-1:count;
}
"#,
        &[("@@TEMPLATE@@", literal(template))],
    )
}
