export type Engine = "sqlite" | "postgresql" | "mysql" | "mariadb" | "mongodb";
export type Mode = "learning" | "work" | "expert";
export type Theme = "dark" | "light" | "system";
export interface ConnectionProfile {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  username: string;
  filePath: string;
  environment: string;
  readOnly: boolean;
  tls: boolean;
  laboratory?: boolean;
  caPath?: string;
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    keyPath: string;
  };
}
export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string;
}
export interface IndexInfo {
  name: string;
  columns: string[];
  unique?: boolean;
  partial?: boolean;
}
export interface ForeignKeyInfo {
  name?: string;
  columns?: string[];
  column?: string;
  referencedTable?: string;
  referencedColumn?: string;
  referencedColumns?: string[];
  targetTable?: string;
  targetColumns?: string[];
}
export interface TableInfo {
  name: string;
  schema?: string;
  kind: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCount?: number;
  definition?: string | null;
}
export interface SchemaSnapshot {
  tables: TableInfo[];
  database: string;
  engine: Engine;
}
export type CellType =
  | "null"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "json"
  | "binary"
  | "datetime"
  | "float";
export interface CellValue {
  type: CellType;
  value?: string | boolean;
}
export type DataRow = Record<string, CellValue>;
export interface ResultSet {
  columns: ColumnInfo[];
  rows: DataRow[];
  table?: string;
  truncated?: boolean;
}
export interface QueryResult {
  sets: ResultSet[];
  elapsedMs: number;
  affectedRows: number;
  message: string;
}
export interface DataChange {
  kind: "insert" | "update" | "delete";
  key: DataRow;
  original: DataRow;
  values: DataRow;
}
export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  engine: Engine;
  favorite: boolean;
  parameters?: Record<string, unknown>;
  executionMode?: string;
}
export interface HistoryEntry {
  id: string;
  query: string;
  engine: Engine;
  profileName: string;
  timestamp: string;
  elapsedMs: number;
  success: boolean;
  error?: string;
}
export interface EngineInfo {
  id?: string;
  engine?: string;
  name: string;
  available?: boolean;
  message?: string;
  capabilities?: string[];
}
export interface Bootstrap {
  profiles: ConnectionProfile[];
  savedQueries: SavedQuery[];
  history: HistoryEntry[];
  settings: Record<string, unknown>;
  engines: EngineInfo[];
}
export interface GenerateRequest {
  engine: Engine;
  language: string;
  output: string;
  table: string;
  query: string;
  columns: ColumnInfo[];
  educational: boolean;
  framework?: string;
}
export interface GeneratedProject {
  files: { path: string; content: string }[];
  command: string;
  notes: string[];
}
export interface EnvironmentInfo {
  id?: string;
  name?: string;
  engine?: string;
  status?: string;
  provider?: string;
  [key: string]: unknown;
}
export const ENGINE_LABELS: Record<Engine, string> = {
  sqlite: "SQLite",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongodb: "MongoDB",
};
export const ENGINE_PORTS: Record<Engine, number> = {
  sqlite: 0,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
};
export const ENGINES = Object.keys(ENGINE_LABELS) as Engine[];
export const LANGUAGES = [
  "Rust",
  "Python",
  "JavaScript",
  "TypeScript",
  "PHP",
  "Java",
  "C#",
  "C",
  "C++",
  "Go",
  "Kotlin",
  "Ruby",
];
