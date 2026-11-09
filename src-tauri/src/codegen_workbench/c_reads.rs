use super::*;
pub(super) fn generate_sql(request: &WorkbenchRequest, plan: &QueryPlan) -> Result<String, String> {
    let kinds = plan
        .bindings
        .iter()
        .map(|p| {
            Ok(match kind(&p.data_type)? {
                "integer" => "DBM_INTEGER",
                "float" => "DBM_REAL",
                "boolean" => "DBM_BOOLEAN",
                "binary" => "DBM_BINARY",
                _ => "DBM_TEXT",
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let names = plan
        .bindings
        .iter()
        .map(|p| literal(&p.name))
        .collect::<Vec<_>>();
    let header=match request.engine.as_str(){"sqlite"=>"#include <sqlite3.h>","postgresql"=>"#include <libpq-fe.h>",_=>"#include <mysql.h>\n#if defined(MARIADB_BASE_VERSION) || defined(MARIADB_VERSION_ID) || MYSQL_VERSION_ID < 80000\ntypedef my_bool DbmMysqlBool;\n#else\ntypedef bool DbmMysqlBool;\n#endif"};
    let common=format!("#pragma once\n#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n#include <inttypes.h>\n#include <limits.h>\n{header}\n\n/* The caller owns the connection. Callback data is valid only until callback return. */\ntypedef struct {{ bool is_null; int64_t integer; double real; bool boolean; const char *text; const void *bytes; size_t length; }} DbmSqlParameter;\ntypedef struct {{ const char *name; const void *data; size_t length; unsigned long native_type; bool is_null; }} DbmReadCell;\ntypedef void (*DbmReadRow)(const DbmReadCell *cells, size_t count, void *context);\nenum {{ DBM_INTEGER, DBM_REAL, DBM_BOOLEAN, DBM_BINARY, DBM_TEXT }};\n#define DBM_BINDING_COUNT {}\nstatic const int DBM_PARAMETER_KINDS[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {{ {} }};\nstatic const char *const DBM_PARAMETER_NAMES[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {{ {} }};\nstatic const char *DBM_READ_SQL = {};\n\n",plan.bindings.len(),if kinds.is_empty(){"DBM_TEXT".into()}else{kinds.join(", ")},if names.is_empty(){"NULL".into()}else{names.join(", ")},literal(&plan.sql));
    let body = match request.engine.as_str() {
        "sqlite" => SQLITE,
        "postgresql" => POSTGRES,
        _ => MYSQL,
    };
    Ok(common + body)
}
pub(super) fn repository(request: &WorkbenchRequest) -> String {
    let connection = match request.engine.as_str() {
        "sqlite" => "sqlite3",
        "postgresql" => "PGconn",
        _ => "MYSQL",
    };
    if request.language == "cpp" {
        format!("\nclass RecordRepository {{\n    {connection} *connection_;\npublic:\n    explicit RecordRepository({connection} *connection): connection_(connection) {{}}\n    int64_t read(const DbmSqlParameter *parameters, size_t count, DbmReadRow callback, void *context) const {{ return read_records(connection_, parameters, count, callback, context); }}\n}};\n")
    } else {
        format!("\ntypedef struct {{ {connection} *connection; }} RecordRepository;\nstatic inline int64_t record_repository_read(RecordRepository *repository, const DbmSqlParameter *parameters, size_t count, DbmReadRow callback, void *context) {{ return read_records(repository->connection, parameters, count, callback, context); }}\n")
    }
}
const SQLITE: &str = r#"static inline int64_t read_records(sqlite3 *connection, const DbmSqlParameter *parameters, size_t count, DbmReadRow callback, void *context) {
    sqlite3_stmt *command = NULL; DbmReadCell *cells = NULL; int64_t rows = 0; int status; int columns;
    if (count != DBM_BINDING_COUNT || (count && !parameters) || !callback) return -1;
    if (sqlite3_prepare_v2(connection, DBM_READ_SQL, -1, &command, NULL) != SQLITE_OK) return -1;
    if (sqlite3_bind_parameter_count(command) != (int)count) goto failed;
    for (size_t index = 0; index < count; index++) {
        const DbmSqlParameter *value = &parameters[index]; int position = (int)index + 1; int result;
        if (value->is_null) result = sqlite3_bind_null(command, position);
        else switch (DBM_PARAMETER_KINDS[index]) {
            case DBM_INTEGER: result = sqlite3_bind_int64(command, position, value->integer); break;
            case DBM_REAL: result = sqlite3_bind_double(command, position, value->real); break;
            case DBM_BOOLEAN: result = sqlite3_bind_int(command, position, value->boolean ? 1 : 0); break;
            case DBM_BINARY:
                if (value->length > INT_MAX || (value->length && !value->bytes)) goto failed;
                result = sqlite3_bind_blob(command, position, value->bytes ? value->bytes : "", (int)value->length, SQLITE_TRANSIENT); break;
            default:
                if (!value->text || value->length > INT_MAX) goto failed;
                result = sqlite3_bind_text(command, position, value->text, value->length ? (int)value->length : -1, SQLITE_TRANSIENT); break;
        }
        if (result != SQLITE_OK) goto failed;
    }
    columns = sqlite3_column_count(command);
    cells = (DbmReadCell *)calloc(columns ? (size_t)columns : 1, sizeof(DbmReadCell)); if (!cells) goto failed;
    while ((status = sqlite3_step(command)) == SQLITE_ROW) {
        for (int index = 0; index < columns; index++) {
            int type = sqlite3_column_type(command, index);
            cells[index].name = sqlite3_column_name(command, index); cells[index].native_type = (unsigned long)type;
            cells[index].is_null = type == SQLITE_NULL;
            cells[index].data = type == SQLITE_BLOB ? sqlite3_column_blob(command, index) : sqlite3_column_text(command, index);
            cells[index].length = (size_t)sqlite3_column_bytes(command, index);
        }
        callback(cells, (size_t)columns, context); rows++;
    }
    if (status != SQLITE_DONE) goto failed;
    free(cells); sqlite3_finalize(command); return rows;
failed:
    fprintf(stderr, "%s\n", sqlite3_errmsg(connection)); free(cells); sqlite3_finalize(command); return -1;
}
"#;
const POSTGRES: &str = r#"static inline int64_t read_records(PGconn *connection, const DbmSqlParameter *parameters, size_t count, DbmReadRow callback, void *context) {
    const char *values[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1];
    int lengths[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {0};
    int formats[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {0};
    char numbers[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1][64];
    PGresult *result; DbmReadCell *cells; int rows; int columns;
    if (count != DBM_BINDING_COUNT || (count && !parameters) || !callback) return -1;
    for (size_t index = 0; index < count; index++) {
        const DbmSqlParameter *value = &parameters[index];
        if (value->is_null) { values[index] = NULL; continue; }
        switch (DBM_PARAMETER_KINDS[index]) {
            case DBM_INTEGER: snprintf(numbers[index], sizeof(numbers[index]), "%" PRId64, value->integer); values[index] = numbers[index]; break;
            case DBM_REAL: snprintf(numbers[index], sizeof(numbers[index]), "%.17g", value->real); values[index] = numbers[index]; break;
            case DBM_BOOLEAN: values[index] = value->boolean ? "true" : "false"; break;
            case DBM_BINARY:
                if (value->length > INT_MAX || (value->length && !value->bytes)) return -1;
                values[index] = (const char *)(value->bytes ? value->bytes : ""); lengths[index] = (int)value->length; formats[index] = 1; break;
            default: if (!value->text) return -1; values[index] = value->text; break;
        }
    }
    result = PQexecParams(connection, DBM_READ_SQL, (int)count, NULL, count ? values : NULL, count ? lengths : NULL, count ? formats : NULL, 0);
    if (!result || PQresultStatus(result) != PGRES_TUPLES_OK) { fprintf(stderr, "%s\n", PQerrorMessage(connection)); if (result) PQclear(result); return -1; }
    rows = PQntuples(result); columns = PQnfields(result);
    cells = (DbmReadCell *)calloc(columns ? (size_t)columns : 1, sizeof(DbmReadCell)); if (!cells) { PQclear(result); return -1; }
    for (int row = 0; row < rows; row++) {
        for (int column = 0; column < columns; column++) {
            cells[column].name = PQfname(result, column); cells[column].native_type = PQftype(result, column);
            cells[column].is_null = PQgetisnull(result, row, column) != 0;
            cells[column].data = cells[column].is_null ? NULL : PQgetvalue(result, row, column);
            cells[column].length = (size_t)PQgetlength(result, row, column);
        }
        callback(cells, (size_t)columns, context);
    }
    free(cells); PQclear(result); return rows;
}
"#;
const MYSQL: &str = r#"static inline int64_t read_records(MYSQL *connection, const DbmSqlParameter *parameters, size_t count, DbmReadRow callback, void *context) {
    MYSQL_STMT *command = NULL; MYSQL_RES *metadata = NULL; MYSQL_FIELD *fields = NULL;
    MYSQL_BIND input[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {0};
    unsigned long input_lengths[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {0};
    DbmMysqlBool input_nulls[DBM_BINDING_COUNT ? DBM_BINDING_COUNT : 1] = {0};
    MYSQL_BIND *output = NULL; unsigned long *lengths = NULL; DbmMysqlBool *nulls = NULL;
    DbmReadCell *cells = NULL; unsigned int columns = 0; int status = 0; int64_t rows = 0; bool failed = false;
    if (count != DBM_BINDING_COUNT || (count && !parameters) || !callback) return -1;
    command = mysql_stmt_init(connection); if (!command) return -1;
    if (mysql_stmt_prepare(command, DBM_READ_SQL, (unsigned long)strlen(DBM_READ_SQL)) || mysql_stmt_param_count(command) != count) goto cleanup_error;
    for (size_t index = 0; index < count; index++) {
        const DbmSqlParameter *value = &parameters[index]; input_nulls[index] = (DbmMysqlBool)value->is_null; input[index].is_null = &input_nulls[index];
        if (value->is_null) { input[index].buffer_type = MYSQL_TYPE_NULL; continue; }
        switch (DBM_PARAMETER_KINDS[index]) {
            case DBM_INTEGER: input[index].buffer_type = MYSQL_TYPE_LONGLONG; input[index].buffer = (void *)&value->integer; break;
            case DBM_REAL: input[index].buffer_type = MYSQL_TYPE_DOUBLE; input[index].buffer = (void *)&value->real; break;
            case DBM_BOOLEAN: input[index].buffer_type = MYSQL_TYPE_TINY; input[index].buffer = (void *)&value->boolean; break;
            case DBM_BINARY:
                if (value->length > ULONG_MAX || (value->length && !value->bytes)) goto cleanup_error;
                input[index].buffer_type = MYSQL_TYPE_BLOB; input[index].buffer = (void *)(value->bytes ? value->bytes : ""); input_lengths[index] = (unsigned long)value->length; break;
            default:
                if (!value->text || value->length > ULONG_MAX) goto cleanup_error;
                input[index].buffer_type = MYSQL_TYPE_STRING; input[index].buffer = (void *)value->text; input_lengths[index] = value->length ? (unsigned long)value->length : (unsigned long)strlen(value->text); break;
        }
        input[index].buffer_length = input_lengths[index]; input[index].length = &input_lengths[index];
    }
    if ((count && mysql_stmt_bind_param(command, input)) || mysql_stmt_execute(command)) goto cleanup_error;
    metadata = mysql_stmt_result_metadata(command); if (!metadata) goto cleanup_error;
    columns = mysql_num_fields(metadata); fields = mysql_fetch_fields(metadata);
    output = (MYSQL_BIND *)calloc(columns ? columns : 1, sizeof(MYSQL_BIND)); lengths = (unsigned long *)calloc(columns ? columns : 1, sizeof(unsigned long));
    nulls = (DbmMysqlBool *)calloc(columns ? columns : 1, sizeof(DbmMysqlBool)); cells = (DbmReadCell *)calloc(columns ? columns : 1, sizeof(DbmReadCell));
    if (!output || !lengths || !nulls || !cells) goto cleanup_error;
    for (unsigned int index = 0; index < columns; index++) { output[index].buffer_type = MYSQL_TYPE_STRING; output[index].length = &lengths[index]; output[index].is_null = &nulls[index]; }
    if (mysql_stmt_bind_result(command, output)) goto cleanup_error;
    while ((status = mysql_stmt_fetch(command)) == 0 || status == MYSQL_DATA_TRUNCATED) {
        for (unsigned int index = 0; index < columns; index++) {
            cells[index].name = fields[index].name; cells[index].is_null = nulls[index] != 0; cells[index].native_type = fields[index].type; cells[index].length = lengths[index]; cells[index].data = NULL;
            if (!cells[index].is_null) {
                MYSQL_BIND column = {0}; char *data = (char *)malloc((size_t)lengths[index] + 1); if (!data) goto cleanup_error;
                cells[index].data = data; column.buffer_type = MYSQL_TYPE_STRING; column.buffer = data; column.buffer_length = lengths[index] + 1; column.length = &lengths[index];
                if (mysql_stmt_fetch_column(command, &column, index, 0)) goto cleanup_error;
                data[lengths[index]] = 0;
            }
        }
        callback(cells, columns, context); rows++;
        for (unsigned int index = 0; index < columns; index++) { free((void *)cells[index].data); cells[index].data = NULL; }
    }
    if (status != MYSQL_NO_DATA) goto cleanup_error;
    goto cleanup;
cleanup_error:
    failed = true; if (command) fprintf(stderr, "%s\n", mysql_stmt_error(command));
cleanup:
    if (cells) { for (unsigned int index = 0; index < columns; index++) free((void *)cells[index].data); }
    free(cells); free(nulls); free(lengths); free(output); if (metadata) mysql_free_result(metadata); if (command) mysql_stmt_close(command);
    return failed ? -1 : rows;
}
"#;
