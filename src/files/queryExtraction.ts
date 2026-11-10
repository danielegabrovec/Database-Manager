/** Bounded static extraction. It never evaluates, imports or runs source files.
 * Literal rules consulted: doc.rust-lang.org/reference/tokens.html;
 * docs.python.org/3/reference/lexical_analysis.html; php.net/manual/en/language.types.string.php;
 * docs.ruby-lang.org/en/master/syntax/literals_rdoc.html; kotlinlang.org/docs/strings.html;
 * go.dev/ref/spec#String_literals; learn.microsoft.com/dotnet/csharp/language-reference/tokens/raw-string;
 * docs.oracle.com/en/java/javase/21/language/text-blocks.html; eel.is/c++draft/lex.string.
 */
export type SourceLanguage =
  | "rust"
  | "python"
  | "javascript"
  | "typescript"
  | "php"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "go"
  | "kotlin"
  | "ruby"
  | "sql"
  | "json"
  | "unknown";
export interface ExtractedParameter {
  name: string;
  placeholder: string;
  kind: "named" | "positional" | "interpolation";
  dataType: "unknown";
  value: null;
  occurrences: number;
}
export interface ExtractedDatabaseOperation {
  id: string;
  label: string;
  language: SourceLanguage;
  kind: "sql" | "mongodb";
  text: string;
  startLine: number;
  endLine: number;
  confidence: "literal" | "partial";
  parameters: ExtractedParameter[];
  warnings: string[];
  context?: string;
}
export interface DatabaseExtractionResult {
  language: SourceLanguage;
  operations: ExtractedDatabaseOperation[];
  warnings: string[];
  truncated: boolean;
}
export interface ExtractionOptions {
  maxCharacters?: number;
  maxOperations?: number;
}
interface Interpolation {
  name: string;
  placeholder: string;
}
interface Token {
  kind: "string" | "id" | "number" | "symbol" | "opaque";
  raw: string;
  value: string;
  start: number;
  end: number;
  scope: number[];
  partial: boolean;
  warnings: string[];
  interpolations: Interpolation[];
}
interface Binding {
  name: string;
  start: number;
  end: number;
  scope: number[];
  token: number;
}
interface Call {
  name: string;
  callee: number;
  open: number;
  end: number;
  args: [number, number][];
}
interface Parsed {
  text: string;
  start: number;
  end: number;
  next: number;
  partial: boolean;
  warnings: string[];
  interpolations: Interpolation[];
}
const MAX_TOKENS = 50000,
  MAX_LITERAL = 500000;
const EXTENSIONS: Record<string, SourceLanguage> = {
  rs: "rust",
  py: "python",
  pyw: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  php: "php",
  java: "java",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hh: "cpp",
  go: "go",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  sql: "sql",
  json: "json",
  mongo: "json",
  mql: "json",
};
export function detectSourceLanguage(fileName: string): SourceLanguage {
  return (
    EXTENSIONS[
      fileName.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() || ""
    ] || "unknown"
  );
}
const SQL_CALLS = new Set([
  "query",
  "queryas",
  "queryscalar",
  "querywith",
  "queryrow",
  "querymap",
  "execute",
  "executequery",
  "executeupdate",
  "exec",
  "executescript",
  "prepare",
  "preparestatement",
  "preparecall",
  "rawquery",
  "queryraw",
  "executeraw",
  "queryasync",
  "executeasync",
  "raw",
  "querycontext",
  "execcontext",
  "sqlite3exec",
  "sqlite3preparev2",
  "sqlite3preparev3",
  "pqexec",
  "pqexecparams",
  "mysqlquery",
  "mysqlrealquery",
  "mysqlstmtprepare",
  "mysqliquery",
]);
const MONGO_CALLS = new Set([
  "find",
  "findone",
  "aggregate",
  "runcmd",
  "runcommand",
  "runcommandasync",
  "runcommanddocument",
  "command",
]);
const COMMAND_KEYS = new Set([
  "find",
  "aggregate",
  "insert",
  "update",
  "delete",
  "count",
  "distinct",
  "create",
  "createIndexes",
  "drop",
  "dropDatabase",
  "listCollections",
  "listDatabases",
  "explain",
  "ping",
  "hello",
  "collStats",
  "dbStats",
  "findAndModify",
]);
const normalize = (value: string) =>
  value.replace(/^[$@]/, "").replaceAll("_", "").toLowerCase();
const idStart = (value: string) => /[\p{L}_$@]/u.test(value);
const idPart = (value: string) => /[\p{L}\p{N}_$@]/u.test(value);
const queryName = (value: string) =>
  /(sql|query|statement|commandtext|ddl|migration)/i.test(value) &&
  !/(description|message|label|title|help)/i.test(value);
const mongoName = (value: string) =>
  /(mongo|pipeline|command|filter)/i.test(value);
const unique = (values: string[]) => [...new Set(values)];
const cleanName = (value: string) => value.replace(/^[$@]/, "");
function clamp(value: number | undefined, fallback: number, maximum: number) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(maximum, Math.floor(Number(value)))
    : fallback;
}
function hash(text: string) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

function balancedSource(source: string, start: number): number {
  let depth = 1;
  for (let i = start; i < source.length && i - start < MAX_LITERAL; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") {
          i++;
          continue;
        }
        if (source[i] === quote) break;
      }
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}" && !--depth) return i + 1;
  }
  return -1;
}
function interpolations(
  body: string,
  mode: "none" | "dollar" | "ruby" | "braces",
  raw: boolean,
  dollars = 1,
): Interpolation[] {
  const result: Interpolation[] = [];
  if (mode === "none") return result;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && !raw) {
      i++;
      continue;
    }
    let prefix = "";
    if (mode === "dollar" && body.startsWith("${", i)) prefix = "${";
    if (mode === "ruby" && body.startsWith("#{", i)) prefix = "#{";
    if (mode === "braces" && body.startsWith("{".repeat(dollars), i)) {
      if (dollars === 1 && !raw && body.startsWith("{{", i)) {
        i++;
        continue;
      }
      prefix = "{".repeat(dollars);
    }
    if (prefix) {
      const end = balancedSource(body, i + prefix.length);
      if (end > 0) {
        const final = Math.min(
          body.length,
          end + (dollars > 1 ? dollars - 1 : 0),
        );
        const placeholder = body.slice(i, final);
        const expression = body.slice(i + prefix.length, end - 1).trim();
        result.push({
          name: expression || `dynamic_${result.length + 1}`,
          placeholder,
        });
        i = final - 1;
        continue;
      }
      result.push({
        name: `dynamic_${result.length + 1}`,
        placeholder: body.slice(i),
      });
      break;
    }
    if (
      mode === "dollar" &&
      body[i] === "$" &&
      body[i + 1] !== "{" &&
      /[A-Za-z_]/.test(body[i + 1] || "")
    ) {
      let end = i + 2;
      while (end < body.length && /[\w]/.test(body[end])) end++;
      result.push({
        name: body.slice(i + 1, end),
        placeholder: body.slice(i, end),
      });
      i = end - 1;
    }
  }
  return result;
}
function decode(
  body: string,
  language: SourceLanguage,
  raw: boolean,
  singleRestricted: boolean,
): { value: string; warnings: string[] } {
  if (raw) return { value: body, warnings: [] };
  let value = "";
  const warnings: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      value += body[i];
      continue;
    }
    const next = body[++i];
    if (next === undefined) {
      warnings.push("Escape finale incompleto.");
      value += "\\";
      break;
    }
    if (singleRestricted && next !== "'" && next !== "\\") {
      value += "\\" + next;
      continue;
    }
    if (next === "\n" || next === "\r") {
      if (next === "\r" && body[i + 1] === "\n") i++;
      if (language === "rust")
        while (/\s/.test(body[i + 1] || "") && i + 1 < body.length) i++;
      continue;
    }
    const common: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      a: "\x07",
      e: "\x1b",
      "0": "\0",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "`": "`",
      $: "$",
    };
    if (next === "s" && language === "java") {
      value += " ";
      continue;
    }
    if (next === "u" && body[i + 1] === "{") {
      const end = body.indexOf("}", i + 2);
      const digits = body.slice(i + 2, end).replaceAll("_", "");
      const code = parseInt(digits, 16);
      if (end > 0 && /^[a-fA-F0-9]{1,6}$/.test(digits) && code <= 0x10ffff) {
        value += String.fromCodePoint(code);
        i = end;
        continue;
      }
    }
    if (next === "u" || next === "U") {
      const count = next === "u" ? 4 : 8;
      const digits = body.slice(i + 1, i + 1 + count);
      const code = parseInt(digits, 16);
      if (
        new RegExp(`^[a-fA-F0-9]{${count}}$`).test(digits) &&
        code <= 0x10ffff
      ) {
        value += String.fromCodePoint(code);
        i += count;
        continue;
      }
    }
    if (next === "x") {
      const match = body
        .slice(i + 1)
        .match(
          language === "csharp"
            ? /^[a-fA-F0-9]{1,4}/
            : language === "c" || language === "cpp"
              ? /^[a-fA-F0-9]+/
              : /^[a-fA-F0-9]{2}/,
        );
      if (match) {
        const code = parseInt(match[0], 16);
        if (
          (language === "c" ||
            language === "cpp" ||
            language === "go" ||
            language === "rust") &&
          code > 127
        ) {
          warnings.push(
            "Escape byte non ASCII: codifica del valore da verificare.",
          );
          value += "\\x" + match[0];
        } else if (code <= 0x10ffff) value += String.fromCodePoint(code);
        else {
          warnings.push("Escape esadecimale non ricostruito.");
          value += "\\x" + match[0];
        }
        i += match[0].length;
        continue;
      }
    }
    if (
      /[0-7]/.test(next) &&
      (/[0-7]/.test(body[i + 1] || "") || next !== "0")
    ) {
      const digits = (next + body.slice(i + 1)).match(/^[0-7]{1,3}/)![0];
      const code = parseInt(digits, 8);
      if (
        (language === "c" || language === "cpp" || language === "go") &&
        code > 127
      ) {
        warnings.push("Escape byte ottale: codifica da verificare.");
        value += "\\" + digits;
      } else value += String.fromCodePoint(code);
      i += digits.length - 1;
      continue;
    }
    if (Object.hasOwn(common, next)) {
      value += common[next];
      continue;
    }
    if (language === "javascript" || language === "typescript") {
      value += next;
      continue;
    }
    value += "\\" + next;
    if (language !== "python" && language !== "ruby" && language !== "php")
      warnings.push(`Escape non ricostruito: \\${next}.`);
  }
  return { value, warnings: unique(warnings) };
}
function dedent(text: string) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const nonEmpty = lines.filter((line) => line.trim());
  const indent = Math.min(
    ...nonEmpty.map((line) => line.match(/^[ \t]*/)![0].length),
  );
  return Number.isFinite(indent)
    ? lines
        .map((line) =>
          line.slice(Math.min(indent, line.match(/^[ \t]*/)![0].length)),
        )
        .join("\n")
    : text;
}

function readString(
  source: string,
  start: number,
  language: SourceLanguage,
): Omit<Token, "scope"> | null {
  const tail = source.slice(start);
  let open = "",
    close = "",
    raw = false,
    restricted = false,
    verbatim = false,
    bodyStart = start;
  let mode: "none" | "dollar" | "ruby" | "braces" = "none";
  let dollars = 1;
  let style = "normal";
  let warnings: string[] = [];
  const rust =
    language === "rust" ? tail.match(/^(?:br|cr|r)(#{0,255})"/) : null;
  const cpp =
    language === "cpp" || language === "c"
      ? tail.match(/^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/)
      : null;
  const heredoc =
    language === "php" || language === "ruby"
      ? tail.match(
          language === "php"
            ? /^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*\r?\n/
            : /^<<([~-]?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*\r?\n/,
        )
      : null;
  if (heredoc) {
    const ruby = language === "ruby",
      name = ruby
        ? heredoc[2] || heredoc[3] || heredoc[4]
        : heredoc[1] || heredoc[2] || heredoc[3];
    const endPattern = new RegExp(
      `^([ \\t]*)${name}(?=;?[ \\t]*(?:\\r?$|[,)]))`,
      "gm",
    );
    bodyStart = start + heredoc[0].length;
    endPattern.lastIndex = bodyStart;
    const match = endPattern.exec(source);
    let value = source.slice(bodyStart, match ? match.index : source.length);
    if (ruby && heredoc[1] === "~") value = dedent(value);
    else if (!ruby && match?.[1])
      value = value
        .split("\n")
        .map((line) =>
          line.startsWith(match[1]) ? line.slice(match[1].length) : line,
        )
        .join("\n");
    raw = ruby ? !!heredoc[2] : !!heredoc[1];
    mode = raw ? "none" : ruby ? "ruby" : "dollar";
    const found = interpolations(value, mode, raw);
    const decoded = decode(value, language, raw, false);
    return {
      kind: "string",
      raw: source.slice(
        start,
        match ? match.index + match[0].length : source.length,
      ),
      value: decoded.value,
      start,
      end: match ? match.index + match[0].length : source.length,
      partial: !match || found.length > 0 || decoded.warnings.length > 0,
      warnings: [
        ...decoded.warnings,
        ...(!match ? ["Heredoc senza delimitatore finale."] : []),
      ],
      interpolations: found,
    };
  }
  if (rust) {
    open = rust[0];
    close = '"' + rust[1];
    raw = true;
    style = "rustRaw";
  } else if (cpp) {
    open = cpp[0];
    close = ")" + cpp[1] + '"';
    raw = true;
    style = "cppRaw";
  } else if (
    language === "ruby" &&
    /^%[qQ]/.test(tail) &&
    tail.length > 2 &&
    !/[\w\s]/.test(tail[2])
  ) {
    const delimiter = tail[2],
      end =
        ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[
          delimiter
        ] || delimiter;
    let depth = 1,
      i = start + 3;
    for (; i < source.length && i - start < MAX_LITERAL; i++) {
      if (source[i] === "\\") {
        i++;
        continue;
      }
      if (delimiter !== end && source[i] === delimiter) depth++;
      if (source[i] === end && !--depth) break;
    }
    const body = source.slice(start + 3, i);
    const found = interpolations(
      body,
      tail[1] === "Q" ? "ruby" : "none",
      false,
    );
    const decoded = decode(body, language, tail[1] === "q", tail[1] === "q");
    return {
      kind: "string",
      raw: source.slice(start, Math.min(source.length, i + 1)),
      value: decoded.value,
      start,
      end: Math.min(source.length, i + 1),
      partial:
        i >= source.length || found.length > 0 || decoded.warnings.length > 0,
      warnings: decoded.warnings,
      interpolations: found,
    };
  } else if (language === "python") {
    const prefix = tail.match(/^([rRuUbBfFtT]{0,2})("""|'''|"|')/);
    if (!prefix) return null;
    open = prefix[0];
    close = prefix[2];
    raw = /r/i.test(prefix[1]);
    mode = /[ft]/i.test(prefix[1]) ? "braces" : "none";
    if (/b/i.test(prefix[1]))
      warnings.push(
        "Literal bytes: verificare la codifica prima di usare il testo SQL.",
      );
  } else if (language === "csharp") {
    const prefix = tail.match(/^((?:\$+@?|@\$*)?)("{1,})/);
    if (!prefix) return null;
    const quotes = prefix[2].length >= 3 ? prefix[2] : '"';
    open = prefix[1] + quotes;
    close = quotes;
    verbatim = prefix[1].includes("@");
    raw = quotes.length >= 3 || verbatim;
    style = quotes.length >= 3 ? "csharpRaw" : "normal";
    dollars = (prefix[1].match(/\$/g) || []).length || 1;
    mode = prefix[1].includes("$") ? "braces" : "none";
  } else {
    const ch = tail[0];
    if (
      (language === "c" || language === "cpp") &&
      /^(?:u8|u|U|L)"/.test(tail)
    ) {
      open = tail.match(/^(?:u8|u|U|L)"/)![0];
      close = '"';
    } else if (
      (language === "java" || language === "kotlin") &&
      tail.startsWith('"""')
    ) {
      open = close = '"""';
      raw = language === "kotlin";
      style = language === "java" ? "javaBlock" : "normal";
    } else if (
      ch === '"' ||
      (ch === "'" &&
        ["javascript", "typescript", "php", "ruby"].includes(language)) ||
      (ch === "`" && ["javascript", "typescript", "go"].includes(language))
    ) {
      open = close = ch;
      raw = language === "go" && ch === "`";
      restricted = ch === "'" && (language === "php" || language === "ruby");
    } else return null;
    if (language === "javascript" || language === "typescript")
      mode = open === "`" ? "dollar" : "none";
    if (language === "kotlin" || language === "php")
      mode = restricted ? "none" : "dollar";
    if (language === "ruby") mode = restricted ? "none" : "ruby";
  }
  bodyStart = start + open.length;
  let i = bodyStart,
    complete = false;
  for (; i < source.length && i - bodyStart <= MAX_LITERAL; i++) {
    if (!raw && source[i] === "\\") {
      i++;
      continue;
    }
    if (raw && language === "python" && source[i] === "\\") {
      i++;
      continue;
    }
    if (verbatim && source.startsWith('""', i)) {
      i++;
      continue;
    }
    let interpolationOpen = "";
    if (mode === "dollar" && source.startsWith("${", i))
      interpolationOpen = "${";
    if (mode === "ruby" && source.startsWith("#{", i)) interpolationOpen = "#{";
    if (mode === "braces" && source.startsWith("{".repeat(dollars), i)) {
      if (dollars === 1 && !raw && source.startsWith("{{", i)) {
        i++;
        continue;
      }
      interpolationOpen = "{".repeat(dollars);
    }
    if (interpolationOpen) {
      const end = balancedSource(source, i + interpolationOpen.length);
      if (end > 0) {
        i = end - 1 + (dollars > 1 ? dollars - 1 : 0);
        continue;
      }
    }
    if (source.startsWith(close, i)) {
      complete = true;
      break;
    }
    if (
      !raw &&
      close.length === 1 &&
      source[i] === "\n" &&
      !["ruby", "php"].includes(language)
    )
      break;
  }
  let body = source.slice(bodyStart, i);
  if (style === "javaBlock" || style === "csharpRaw") {
    const opening = body.match(/^[ \t]*\r?\n/);
    if (opening) {
      body = body.slice(opening[0].length);
      const closing = body.match(/(?:^|\n)([ \t]*)$/);
      const indent = closing?.[1] || "";
      if (style === "csharpRaw") {
        if (closing) body = body.slice(0, closing.index);
        body = body
          .split(/\r?\n/)
          .map((line) => {
            if (line.trim() && !line.startsWith(indent))
              warnings.push(
                "Indentazione del raw string C# non coerente con il delimitatore finale.",
              );
            return line.startsWith(indent) ? line.slice(indent.length) : line;
          })
          .join("\n");
      } else {
        const lines = body.split(/\r?\n/),
          widths = lines
            .filter((line) => line.trim())
            .map((line) => line.match(/^[ \t]*/)![0].length);
        if (closing) widths.push(indent.length);
        const width = Math.min(...widths);
        body = lines
          .map((line) =>
            line
              .slice(
                Math.min(
                  Number.isFinite(width) ? width : 0,
                  line.match(/^[ \t]*/)![0].length,
                ),
              )
              .replace(/[ \t]+$/, ""),
          )
          .join("\n");
      }
    }
  }
  if (verbatim) body = body.replaceAll('""', '"');
  const found = interpolations(body, mode, raw, dollars);
  const decoded = decode(body, language, raw, restricted);
  let value = decoded.value;
  if (mode === "braces" && !raw && dollars === 1)
    value = value.replaceAll("{{", "{").replaceAll("}}", "}");
  if (language === "go" && raw) value = value.replaceAll("\r", "");
  if (!complete)
    warnings.push(
      i - bodyStart > MAX_LITERAL
        ? "Literal oltre il limite di analisi."
        : "Literal senza delimitatore finale.",
    );
  warnings.push(...decoded.warnings);
  return {
    kind: "string",
    raw: source.slice(
      start,
      Math.min(source.length, i + (complete ? close.length : 0)),
    ),
    value,
    start,
    end: Math.min(source.length, i + (complete ? close.length : 0)),
    partial: !complete || found.length > 0 || warnings.length > 0,
    warnings: unique(warnings),
    interpolations: found,
  };
}

function lex(
  source: string,
  language: SourceLanguage,
): { tokens: Token[]; limited: boolean; warnings: string[] } {
  const tokens: Token[] = [],
    scope: number[] = [];
  const warnings: string[] = [];
  const push = (
    kind: Token["kind"],
    start: number,
    end: number,
    value = source.slice(start, end),
  ) =>
    tokens.push({
      kind,
      raw: source.slice(start, end),
      value,
      start,
      end,
      scope: [...scope],
      partial: false,
      warnings: [],
      interpolations: [],
    });
  for (let i = 0; i < source.length;) {
    if (tokens.length >= MAX_TOKENS)
      return {
        tokens,
        limited: true,
        warnings: [
          "Troppi elementi nel file: l’estrazione è stata fermata senza ricostruire codice incompleto.",
        ],
      };
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (
      source.startsWith("//", i) ||
      ((language === "python" || language === "ruby" || language === "php") &&
        ch === "#" &&
        !(language === "php" && source[i + 1] === "["))
    ) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1,
        j = i + 2;
      for (; j < source.length && depth; j++) {
        if (source.startsWith("/*", j)) {
          depth++;
          j++;
        } else if (source.startsWith("*/", j)) {
          depth--;
          j++;
        }
      }
      if (depth) warnings.push("Commento di blocco non terminato.");
      i = j;
      continue;
    }
    if (
      language === "ruby" &&
      source.startsWith("=begin", i) &&
      (i === 0 || source[i - 1] === "\n")
    ) {
      const match = /^=end\b.*$/gm;
      match.lastIndex = i + 6;
      const end = match.exec(source);
      i = end ? end.index + end[0].length : source.length;
      continue;
    }
    if ((language === "php" || language === "ruby") && ch === "`") {
      let j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === "\\") j++;
        else if (source[j] === "`") break;
      }
      push("opaque", i, Math.min(source.length, j + 1));
      i = Math.min(source.length, j + 1);
      continue;
    }
    const string = readString(source, i, language);
    if (string) {
      tokens.push({ ...string, scope: [...scope] });
      i = Math.max(i + 1, string.end);
      continue;
    }
    if (
      ch === "'" &&
      !["python", "javascript", "typescript", "php", "ruby"].includes(language)
    ) {
      const end = source.slice(i + 1).search(/['\r\n]/);
      if (end >= 0 && source[i + 1 + end] === "'" && end < 14) {
        push("opaque", i, i + end + 2);
        i += end + 2;
      } else {
        i++;
      }
      continue;
    }
    if (
      (language === "javascript" ||
        language === "typescript" ||
        language === "ruby") &&
      ch === "/" &&
      (!tokens.length ||
        /[=(:,[!;?]/.test(tokens[tokens.length - 1].value) ||
        tokens[tokens.length - 1].value === "return")
    ) {
      let bracket = false,
        j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === "\\") {
          j++;
          continue;
        }
        if (source[j] === "[") bracket = true;
        if (source[j] === "]") bracket = false;
        if (source[j] === "/" && !bracket) {
          j++;
          while (/[A-Za-z]/.test(source[j] || "")) j++;
          break;
        }
        if (source[j] === "\n") break;
      }
      push("opaque", i, j);
      i = j;
      continue;
    }
    if (idStart(ch)) {
      let j = i + 1;
      while (j < source.length && idPart(source[j])) j++;
      push("id", i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_.]/.test(source[j])) j++;
      push("number", i, j);
      i = j;
      continue;
    }
    if (ch === "}") scope.pop();
    push("symbol", i, i + 1);
    if (ch === "{") scope.push(i);
    i++;
  }
  return { tokens, limited: false, warnings };
}
function matching(tokens: Token[], start: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[tokens[start]?.value]];
  if (!stack[0]) return -1;
  for (let i = start + 1; i < tokens.length && i - start < 10000; i++) {
    if (tokens[i].kind === "string" || tokens[i].kind === "opaque") continue;
    const v = tokens[i].value;
    if (pairs[v]) stack.push(pairs[v]);
    else if (v === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}
function callsFrom(tokens: Token[]): Call[] {
  const result: Call[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "(") continue;
    let callee = i - 1;
    if (tokens[callee]?.value === "!") callee--;
    if (tokens[callee]?.value === ">") {
      let depth = 1;
      for (callee--; callee >= 0; callee--) {
        if (tokens[callee].value === ">") depth++;
        if (tokens[callee].value === "<" && !--depth) {
          callee--;
          break;
        }
      }
      while (tokens[callee]?.value === ":") callee--;
    }
    if (tokens[callee]?.kind !== "id") continue;
    const end = matching(tokens, i);
    if (end < 0) continue;
    const args: [number, number][] = [];
    let start = i + 1;
    for (let j = start; j < end; j++) {
      if (
        ["(", "[", "{"].includes(tokens[j].value) &&
        tokens[j].kind !== "string"
      ) {
        const close = matching(tokens, j);
        if (close >= 0) {
          j = close;
          continue;
        }
      }
      if (tokens[j].value === ",") {
        args.push([start, j]);
        start = j + 1;
      }
    }
    if (start < end) args.push([start, end]);
    result.push({
      name: normalize(tokens[callee].value),
      callee,
      open: i,
      end,
      args,
    });
  }
  return result;
}
function expressionEnd(tokens: Token[], start: number, source: string): number {
  let i = start;
  for (; i < tokens.length && i - start < 2000; i++) {
    const token = tokens[i];
    if (
      token.kind !== "string" &&
      token.kind !== "opaque" &&
      ["(", "[", "{"].includes(token.value)
    ) {
      const end = matching(tokens, i);
      if (end >= 0) {
        i = end;
        continue;
      }
    }
    if (token.kind === "symbol" && [";", ",", "}", ")"].includes(token.value))
      return i;
    if (
      i > start &&
      /[\r\n]/.test(source.slice(tokens[i - 1].end, token.start)) &&
      !["+", ".", "\\"].includes(tokens[i - 1].value) &&
      !["+", "."].includes(token.value)
    )
      return i;
  }
  return i;
}
function bindingsFrom(
  tokens: Token[],
  source: string,
  language: SourceLanguage,
): Binding[] {
  const result: Binding[] = [];
  for (let i = 1; i < tokens.length - 1; i++) {
    if (
      tokens[i].value !== "=" ||
      ["=", "!", ">", "<"].includes(tokens[i - 1].value) ||
      tokens[i + 1].value === "="
    )
      continue;
    let previous = i - 1;
    if (tokens[previous]?.value === ":") previous--;
    let name =
      tokens[previous]?.kind === "id" ? cleanName(tokens[previous].value) : "";
    let statement = i - 1;
    while (
      statement >= 0 &&
      i - statement < 35 &&
      ![";", "{", "}"].includes(tokens[statement].value)
    )
      statement--;
    const left = tokens.slice(statement + 1, i);
    const declaration = left.findIndex((token) =>
      ["const", "static", "let", "var", "val"].includes(token.value),
    );
    if (declaration >= 0) {
      let next = declaration + 1;
      while (["mut", "final", "val", "var"].includes(left[next]?.value)) next++;
      if (
        left[next]?.kind === "id" &&
        ["rust", "javascript", "typescript", "go", "kotlin"].includes(language)
      )
        name = cleanName(left[next].value);
    }
    const colon = left.findIndex(
      (token, index) =>
        token.value === ":" &&
        left[index - 1]?.value !== ":" &&
        left[index + 1]?.value !== ":",
    );
    if (colon > 0 && left[colon - 1].kind === "id")
      name = cleanName(left[colon - 1].value);
    if (name)
      result.push({
        name,
        start: i + 1,
        end: expressionEnd(tokens, i + 1, source),
        scope: [...tokens[i].scope],
        token: i,
      });
  }
  for (let i = 1; i < tokens.length - 1; i++)
    if (tokens[i - 1].value === "define" && tokens[i].kind === "id")
      result.push({
        name: cleanName(tokens[i].value),
        start: i + 1,
        end: expressionEnd(tokens, i + 1, source),
        scope: [...tokens[i].scope],
        token: i,
      });
  return result;
}
function visibleBinding(
  bindings: Binding[],
  name: string,
  at: number,
  scope: number[],
): Binding | undefined {
  return bindings
    .filter(
      (binding) =>
        binding.name === cleanName(name) &&
        binding.token < at &&
        binding.scope.every((part, index) => scope[index] === part),
    )
    .at(-1);
}
function sqlLeading(text: string): string {
  let i = text[0] === "\uFEFF" ? 1 : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      for (; i < text.length && depth; i++) {
        if (text.startsWith("/*", i)) {
          depth++;
          i++;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i++;
        }
      }
      continue;
    }
    break;
  }
  return text.slice(i);
}
function sqlCandidate(text: string): boolean {
  const value = sqlLeading(text);
  return /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|EXPLAIN|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|GRANT|REVOKE|SHOW|DESCRIBE|USE|VACUUM|REINDEX|ATTACH|DETACH|ANALYZE|SET|CALL|EXECUTE|MERGE|REPLACE|COMMENT|DO|VALUES)\b/i.test(
    value,
  );
}
function mongoShape(value: unknown): "command" | "pipeline" | "batch" | null {
  if (Array.isArray(value)) {
    if (
      value.length &&
      value.every(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).some((key) => key.startsWith("$")),
      )
    )
      return "pipeline";
    if (value.length && value.every((item) => mongoShape(item) === "command"))
      return "batch";
    return null;
  }
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).some((key) => COMMAND_KEYS.has(key))
  )
    return "command";
  return null;
}
function jsonShape(text: string) {
  try {
    return mongoShape(JSON.parse(text));
  } catch {
    return null;
  }
}
function mongoDraft(text: string, markers: Interpolation[]): string | null {
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length;) {
    const marker = markers.find(
      (marker) => marker.placeholder && text.startsWith(marker.placeholder, i),
    );
    if (marker) {
      value += quoted ? "{{DYNAMIC}}" : JSON.stringify("{{DYNAMIC}}");
      i += marker.placeholder.length;
      continue;
    }
    const character = text[i++];
    value += character;
    if (character === "\\" && quoted && i < text.length) {
      value += text[i++];
      continue;
    }
    if (character === '"') quoted = !quoted;
  }
  return jsonShape(value) ? value : null;
}

function stringExpression(
  tokens: Token[],
  start: number,
  source: string,
  language: SourceLanguage,
): Parsed {
  const first = tokens[start];
  let text = first.value,
    end = first.end,
    next = start + 1,
    partial = first.partial;
  const warnings = [...first.warnings],
    found = [...first.interpolations];
  while (next < tokens.length) {
    const token = tokens[next];
    if (
      (token.value === "+" || (language === "php" && token.value === ".")) &&
      tokens[next + 1]
    ) {
      let term = next + 1,
        finish = term + 1;
      while (
        finish < tokens.length &&
        !["+", ",", ";", ")", "]", "}"].includes(tokens[finish].value) &&
        !(language === "php" && tokens[finish].value === ".") &&
        finish - term < 80
      ) {
        if (["(", "[", "{"].includes(tokens[finish].value)) {
          const match = matching(tokens, finish);
          if (match >= 0) {
            finish = match + 1;
            continue;
          }
        }
        finish++;
      }
      if (tokens[term].kind === "string" && finish === term + 1) {
        text += tokens[term].value;
        partial ||= tokens[term].partial;
        warnings.push(...tokens[term].warnings);
        found.push(...tokens[term].interpolations);
      } else {
        const expression = source
          .slice(tokens[term].start, tokens[Math.max(term, finish - 1)].end)
          .trim();
        text += "{{DYNAMIC}}";
        partial = true;
        found.push({
          name: expression.slice(0, 80) || `dynamic_${found.length + 1}`,
          placeholder: "{{DYNAMIC}}",
        });
        warnings.push(
          "Concatenazione con un’espressione non letterale: valore non ricostruito.",
        );
      }
      end = tokens[Math.max(term, finish - 1)].end;
      next = finish;
      continue;
    }
    if (
      token.kind === "string" &&
      ["c", "cpp", "python"].includes(language) &&
      !/[;{}]/.test(source.slice(end, token.start))
    ) {
      text += token.value;
      end = token.end;
      next++;
      partial ||= token.partial;
      warnings.push(...token.warnings);
      found.push(...token.interpolations);
      continue;
    }
    break;
  }
  if (
    language === "kotlin" &&
    tokens[next]?.value === "." &&
    ["trimIndent", "trimMargin"].includes(tokens[next + 1]?.value) &&
    tokens[next + 2]?.value === "("
  ) {
    const close = matching(tokens, next + 2);
    if (close >= 0) {
      if (tokens[next + 1].value === "trimIndent")
        text = dedent(text).replace(/^\s*\n|\n\s*$/g, "");
      else {
        const prefix =
          tokens[next + 3]?.kind === "string" ? tokens[next + 3].value : "|";
        text = text
          .split(/\r?\n/)
          .map((line) => {
            const index = line.indexOf(prefix);
            return index >= 0 && /^\s*$/.test(line.slice(0, index))
              ? line.slice(index + prefix.length)
              : line;
          })
          .join("\n")
          .replace(/^\s*\n|\n\s*$/g, "");
      }
      end = tokens[close].end;
      next = close + 1;
    }
  }
  return {
    text,
    start: first.start,
    end,
    next,
    partial,
    warnings: unique(warnings),
    interpolations: found,
  };
}

function collectParameters(
  text: string,
  dynamic: Interpolation[] = [],
): ExtractedParameter[] {
  const result: ExtractedParameter[] = [],
    map = new Map<string, ExtractedParameter>();
  let positional = 0;
  const add = (
    name: string,
    placeholder: string,
    kind: ExtractedParameter["kind"],
  ) => {
    if (kind === "positional" && /^\d+$/.test(name))
      positional = Math.max(positional, Number(name));
    const key = kind + ":" + name;
    const existing = map.get(key);
    if (existing) {
      existing.occurrences++;
      return;
    }
    const parameter: ExtractedParameter = {
      name,
      placeholder,
      kind,
      dataType: "unknown",
      value: null,
      occurrences: 1,
    };
    map.set(key, parameter);
    result.push(parameter);
  };
  const dynamicTokens = [...dynamic].sort(
    (a, b) => b.placeholder.length - a.placeholder.length,
  );
  for (let i = 0; i < text.length;) {
    const marker = dynamicTokens.find(
      (item) => item.placeholder && text.startsWith(item.placeholder, i),
    );
    if (marker) {
      i += marker.placeholder.length;
      continue;
    }
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      for (i++; i < text.length; i++) {
        if (text[i] === close) {
          if (text[i + 1] === close) {
            i++;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\\") i++;
      }
      continue;
    }
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      for (; i < text.length && depth; i++) {
        if (text.startsWith("/*", i)) {
          depth++;
          i++;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i++;
        }
      }
      continue;
    }
    if (ch === "$") {
      const quote = text.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/);
      if (quote) {
        const end = text.indexOf(quote[0], i + quote[0].length);
        i = end < 0 ? text.length : end + quote[0].length;
        continue;
      }
    }
    const tail = text.slice(i);
    let match: RegExpMatchArray | null = null;
    if (ch === ":" && text[i - 1] !== ":" && text[i + 1] !== ":")
      match = tail.match(/^:([A-Za-z_]\w*)/);
    else if (ch === "@" && text[i - 1] !== "@" && text[i + 1] !== "@")
      match = tail.match(/^@([A-Za-z_]\w*)/);
    else if (ch === "$") match = tail.match(/^\$([A-Za-z_]\w*|\d+)/);
    if (match) {
      add(match[1], match[0], /^\d+$/.test(match[1]) ? "positional" : "named");
      i += match[0].length;
      continue;
    }
    const py = tail.match(/^%\(([A-Za-z_]\w*)\)s/);
    if (py) {
      add(py[1], py[0], "named");
      i += py[0].length;
      continue;
    }
    if (ch === "?" || tail.startsWith("%s")) {
      const numbered = ch === "?" ? tail.match(/^\?(\d+)/) : null;
      const placeholder = numbered?.[0] || (ch === "?" ? "?" : "%s");
      add(numbered?.[1] || String(++positional), placeholder, "positional");
      i += placeholder.length;
      continue;
    }
    i++;
  }
  for (const item of dynamic) add(item.name, item.placeholder, "interpolation");
  return result;
}

/** Parses only structural literals. Identifier values and calls become explicit
 * draft markers; no JS/Python/Rust expression is evaluated. */
function parseObject(
  tokens: Token[],
  start: number,
  bindings: Binding[],
  source: string,
  depth = 0,
  visited = new Set<number>(),
): Parsed | null {
  if (depth > 24 || !tokens[start]) return null;
  const token = tokens[start];
  if (token.kind === "string")
    return {
      text: JSON.stringify(token.value),
      start: token.start,
      end: token.end,
      next: start + 1,
      partial: token.partial,
      warnings: token.warnings,
      interpolations: token.interpolations,
    };
  if (
    token.kind === "number" ||
    (token.value === "-" && tokens[start + 1]?.kind === "number")
  ) {
    const raw =
      token.value === "-" ? "-" + tokens[start + 1].value : token.value;
    const next = start + (token.value === "-" ? 2 : 1);
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw))
      return {
        text: raw,
        start: token.start,
        end: tokens[next - 1].end,
        next,
        partial: false,
        warnings: [],
        interpolations: [],
      };
  }
  if (
    ["true", "false", "null", "True", "False", "None", "nil"].includes(
      token.value,
    )
  )
    return {
      text:
        (
          { True: "true", False: "false", None: "null", nil: "null" } as Record<
            string,
            string
          >
        )[token.value] || token.value,
      start: token.start,
      end: token.end,
      next: start + 1,
      partial: false,
      warnings: [],
      interpolations: [],
    };
  if (token.kind === "id") {
    const binding = visibleBinding(bindings, token.value, start, token.scope);
    if (binding && !visited.has(binding.token)) {
      const seen = new Set(visited);
      seen.add(binding.token);
      const resolved = parseObject(
        tokens,
        binding.start,
        bindings,
        source,
        depth + 1,
        seen,
      );
      if (resolved && resolved.next <= binding.end)
        return { ...resolved, next: start + 1 };
    }
    if (
      normalize(token.value) === "doc" &&
      tokens[start + 1]?.value === "!" &&
      tokens[start + 2]?.value === "{"
    ) {
      const parsed = parseObject(
        tokens,
        start + 2,
        bindings,
        source,
        depth + 1,
        visited,
      );
      if (parsed) {
        parsed.partial = true;
        parsed.warnings.push(
          "Macro BSON trascritta solo nei valori letterali: tipi e opzioni richiedono revisione.",
        );
        return parsed;
      }
    }
  }
  const object = token.value === "{",
    array = token.value === "[";
  if (!object && !array) return null;
  const end = matching(tokens, start);
  if (end < 0) return null;
  const parts: string[] = [],
    warnings: string[] = [],
    found: Interpolation[] = [];
  let partial = false,
    i = start + 1;
  while (i < end) {
    let key = "";
    if (object) {
      const keyToken = tokens[i];
      if (keyToken?.kind !== "string" && keyToken?.kind !== "id") return null;
      key = keyToken.value;
      if (tokens[i + 1]?.value !== ":") return null;
      i += 2;
    }
    let parsed = parseObject(tokens, i, bindings, source, depth + 1, visited);
    if (!parsed) {
      let finish = i + 1;
      for (; finish < end && tokens[finish].value !== ","; finish++) {
        if (["(", "[", "{"].includes(tokens[finish].value)) {
          const close = matching(tokens, finish);
          if (close >= 0) finish = close;
        }
      }
      const expression = source.slice(tokens[i].start, tokens[finish - 1].end);
      parsed = {
        text: JSON.stringify("{{DYNAMIC}}"),
        start: tokens[i].start,
        end: tokens[finish - 1].end,
        next: finish,
        partial: true,
        warnings: [
          "Il documento contiene un’espressione non letterale, sostituita da un marcatore di bozza.",
        ],
        interpolations: [
          {
            name: expression.slice(0, 80) || "dynamic",
            placeholder: "{{DYNAMIC}}",
          },
        ],
      };
    }
    parts.push((object ? JSON.stringify(key) + ":" : "") + parsed.text);
    partial ||= parsed.partial;
    warnings.push(...parsed.warnings);
    found.push(...parsed.interpolations);
    i = parsed.next;
    if (tokens[i]?.value === ",") i++;
    else if (i < end) return null;
  }
  return {
    text: (object ? "{" : "[") + parts.join(",") + (object ? "}" : "]"),
    start: token.start,
    end: tokens[end].end,
    next: end + 1,
    partial,
    warnings: unique(warnings),
    interpolations: found,
  };
}
function collectionName(
  tokens: Token[],
  call: Call,
  calls: Call[],
  bindings: Binding[],
): string | null {
  let owner = call.callee - 2;
  if (tokens[call.callee - 1]?.value !== ".") return null;
  if (tokens[owner]?.value === ")") {
    const collection = calls.find(
      (candidate) =>
        candidate.end === owner &&
        ["collection", "getcollection"].includes(candidate.name),
    );
    if (collection) {
      const arg = collection.args[0];
      if (arg && tokens[arg[0]]?.kind === "string" && !tokens[arg[0]].partial)
        return tokens[arg[0]].value;
    }
  }
  if (
    tokens[owner]?.value === "]" &&
    tokens[owner - 1]?.kind === "string" &&
    tokens[owner - 2]?.value === "["
  )
    return tokens[owner - 1].value;
  if (tokens[owner]?.kind === "id") {
    if (
      tokens[owner - 1]?.value === "." &&
      tokens[owner - 2]?.kind === "id" &&
      /db$|database|mongo/i.test(tokens[owner - 2].value)
    )
      return tokens[owner].value;
    const binding = visibleBinding(
      bindings,
      tokens[owner].value,
      call.callee,
      tokens[call.callee].scope,
    );
    if (binding) {
      const collection = calls.find(
        (candidate) =>
          candidate.callee >= binding.start &&
          candidate.end <= binding.end &&
          ["collection", "getcollection"].includes(candidate.name),
      );
      const arg = collection?.args[0];
      if (arg && tokens[arg[0]]?.kind === "string" && !tokens[arg[0]].partial)
        return tokens[arg[0]].value;
    }
  }
  return null;
}

export function extractDatabaseOperations(
  source: string,
  fileName: string,
  options: ExtractionOptions = {},
): DatabaseExtractionResult {
  const language = detectSourceLanguage(fileName);
  const result: DatabaseExtractionResult = {
    language,
    operations: [],
    warnings: [
      "Analisi statica: il file non viene eseguito, importato o valutato. Rivedi le istruzioni prima di usarle.",
    ],
    truncated: false,
  };
  const limit = clamp(options.maxCharacters, 2_000_000, 8_000_000),
    maximum = clamp(options.maxOperations, 250, 1000);
  if (source.length > limit) {
    result.truncated = true;
    result.warnings.push(
      `Il file supera ${limit.toLocaleString("it-IT")} caratteri. L’estrazione è stata fermata; usa un file più piccolo.`,
    );
    return result;
  }
  if (source.includes("\0")) {
    result.warnings.push(
      "Il contenuto contiene byte NUL e non viene interpretato come sorgente testuale.",
    );
    return result;
  }
  if (language === "unknown") {
    result.warnings.push(
      "Estensione generica o non riconosciuta: nessuna stringa viene promossa automaticamente a query. Usa un file SQL, JSON MongoDB o uno dei dodici linguaggi supportati.",
    );
    return result;
  }
  const breaks = [-1];
  for (let i = 0; i < source.length; i++)
    if (source[i] === "\n" || (source[i] === "\r" && source[i + 1] !== "\n"))
      breaks.push(i);
  function line(offset: number) {
    let low = 0,
      high = breaks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (breaks[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return Math.max(1, low);
  }
  const seen = new Set<string>();
  function emit(
    kind: ExtractedDatabaseOperation["kind"],
    text: string,
    start: number,
    end: number,
    partial: boolean,
    warnings: string[],
    context: string,
    dynamic: Interpolation[] = [],
    label?: string,
  ) {
    const key = `${kind}:${start}:${end}`;
    if (seen.has(key) || !text.trim()) return;
    seen.add(key);
    if (result.operations.length >= maximum) {
      result.truncated = true;
      return;
    }
    const params =
      kind === "sql"
        ? collectParameters(text, dynamic)
        : dynamic.map((item, index) => ({
            name: item.name || `dynamic_${index + 1}`,
            placeholder: item.placeholder,
            kind: "interpolation" as const,
            dataType: "unknown" as const,
            value: null,
            occurrences: 1,
          }));
    if (partial)
      warnings.push(
        "Bozza parziale: concatenazioni, interpolazioni o parti non risolte non sono state eseguite.",
      );
    if (params.some((parameter) => parameter.kind !== "interpolation"))
      warnings.push(
        "I segnaposto non forniscono i valori dei binding: completa i parametri nel contesto del driver prima dell’esecuzione.",
      );
    result.operations.push({
      id: `extract-${hash(fileName + "\0" + kind + "\0" + start + "\0" + text)}-${start}`,
      label:
        label ||
        (kind === "sql"
          ? `${
              text
                .trim()
                .match(/^[A-Za-z]+/)?.[0]
                ?.toUpperCase() || "SQL"
            } · riga ${line(start)}`
          : `MongoDB · riga ${line(start)}`),
      language,
      kind,
      text,
      startLine: line(start),
      endLine: line(Math.max(start, end - 1)),
      confidence: partial ? "partial" : "literal",
      parameters: params,
      warnings: unique(warnings),
      context,
    });
  }
  if (language === "sql") {
    if (
      sqlCandidate(source) ||
      /^(?:DELIMITER\b|\\(?:connect|i)\b|\.read\b)/i.test(sqlLeading(source))
    )
      emit(
        "sql",
        source,
        0,
        source.length,
        /^\s*(?:DELIMITER\b|\\(?:connect|i)\b|\.read\b)/im.test(source),
        [],
        "File SQL intero",
        [],
        "Script SQL completo",
      );
    else
      result.warnings.push(
        "Il file SQL non contiene un’istruzione iniziale riconosciuta o contiene soltanto commenti.",
      );
    return result;
  }
  if (language === "json") {
    const shape = jsonShape(source);
    if (shape) {
      emit(
        "mongodb",
        source,
        0,
        source.length,
        false,
        shape === "pipeline"
          ? [
              "Pipeline autonoma: specificare la collezione in un comando aggregate prima di eseguirla.",
            ]
          : [],
        "JSON / Extended JSON letterale",
        [],
        shape === "pipeline"
          ? "Pipeline MongoDB"
          : shape === "batch"
            ? "Sequenza comandi MongoDB"
            : "Comando MongoDB",
      );
    } else
      result.warnings.push(
        "Il file non è un comando o una pipeline JSON MongoDB riconosciuta. Non viene interpretato JavaScript né convertito un JSON generico in istruzioni database.",
      );
    return result;
  }
  const scanned = lex(source, language);
  result.warnings.push(...scanned.warnings);
  if (scanned.limited) {
    result.truncated = true;
    return result;
  }
  const tokens = scanned.tokens,
    calls = callsFrom(tokens),
    bindings = bindingsFrom(tokens, source, language);
  const promoted = new Set<number>();
  for (const call of calls)
    if (SQL_CALLS.has(call.name)) {
      const sqlArgument = [
        "querycontext",
        "execcontext",
        "sqlite3exec",
        "sqlite3preparev2",
        "sqlite3preparev3",
        "pqexec",
        "pqexecparams",
        "mysqlquery",
        "mysqlrealquery",
        "mysqlstmtprepare",
        "mysqliquery",
      ].includes(call.name)
        ? 1
        : 0;
      const arg = call.args[sqlArgument];
      if (arg)
        for (let i = arg[0]; i < arg[1]; i++)
          if (tokens[i].kind === "id") {
            const binding = visibleBinding(
              bindings,
              tokens[i].value,
              i,
              tokens[i].scope,
            );
            if (binding) promoted.add(binding.token);
          }
    }
  const consumed = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "string" || consumed.has(i)) continue;
    const group = stringExpression(tokens, i, source, language);
    for (let j = i; j < group.next; j++)
      if (tokens[j].kind === "string") consumed.add(j);
    const draft = group.interpolations.length
      ? mongoDraft(group.text, group.interpolations)
      : null;
    if (draft) {
      group.text = draft;
      group.partial = true;
      group.warnings.push(
        "Interpolazioni JSON sostituite con marcatori di bozza, senza valutarne il contenuto.",
      );
    }
    const sql = sqlCandidate(group.text),
      shape = jsonShape(group.text);
    if (!sql && !shape) continue;
    const binding = bindings
      .filter((binding) => i >= binding.start && i < binding.end)
      .at(-1);
    const driver = calls
      .filter(
        (call) =>
          call.args.some((arg) => i >= arg[0] && i < arg[1]) &&
          (SQL_CALLS.has(call.name) ||
            MONGO_CALLS.has(call.name) ||
            ["parse", "fromjson", "bsonnewfromjson"].includes(call.name)),
      )
      .sort((a, b) => a.end - a.open - (b.end - b.open))[0];
    const tag =
      tokens[i - 1]?.kind === "id" &&
      ["sql", "queryraw", "executeraw"].includes(
        normalize(tokens[i - 1].value),
      );
    const property =
      tokens[i - 1]?.value === ":" && tokens[i - 2]?.kind === "id"
        ? tokens[i - 2].value
        : "";
    const annotation =
      /\/\*\s*(?:sql|language\s*=\s*sql)\s*\*\/\s*$|#\s*language\s*=\s*sql[^\n]*\n\s*$/i.test(
        source.slice(Math.max(0, token.start - 120), token.start),
      );
    const intent =
      !!driver ||
      tag ||
      annotation ||
      (!!binding && (queryName(binding.name) || promoted.has(binding.token))) ||
      queryName(property);
    if (!intent && !(shape && binding && mongoName(binding.name))) continue;

    const formatter = calls.find(
      (call) =>
        i > call.open &&
        i < call.end &&
        ["format", "sprintf", "snprintf", "asprintf", "join"].includes(
          call.name,
        ),
    );
    const suffix =
      tokens[group.next]?.value === "." ? tokens[group.next + 1]?.value : "";
    if (
      formatter ||
      ["format", "formatted", "arg"].includes(suffix) ||
      tokens[group.next]?.value === "%" ||
      tokens[group.next]?.value === "+"
    ) {
      group.partial = true;
      group.warnings.push(
        "Formattazione o trasformazione del testo non valutata.",
      );
      for (const placeholder of group.text.matchAll(/\{[^{}]*\}|%[sdf]/g))
        group.interpolations.push({
          name: placeholder[0],
          placeholder: placeholder[0],
        });
      if (formatter) group.end = tokens[formatter.end].end;
    }
    const before = tokens[i - 1];
    if (
      before?.value === "(" &&
      ["format", "formatraw"].includes(normalize(tokens[i - 2]?.value || ""))
    ) {
      group.partial = true;
      group.warnings.push("Macro di formattazione non valutata.");
    }
    const context = driver
      ? `Literal usato da ${tokens[driver.callee].value}`
      : binding
        ? `Assegnazione ${binding.name}`
        : tag
          ? "Template SQL marcato"
          : "Literal SQL annotato";
    if (sql)
      emit(
        "sql",
        group.text,
        group.start,
        group.end,
        group.partial,
        group.warnings,
        context,
        group.interpolations,
        binding ? `SQL · ${binding.name}` : undefined,
      );
    else if (jsonShape(group.text))
      emit(
        "mongodb",
        group.text,
        group.start,
        group.end,
        group.partial,
        [
          ...group.warnings,
          ...(shape === "pipeline"
            ? [
                "Pipeline autonoma: verificare nome della collezione e comando aggregate.",
              ]
            : []),
        ],
        context,
        group.interpolations,
        binding ? `MongoDB · ${binding.name}` : undefined,
      );
  }
  for (const call of calls) {
    if (!MONGO_CALLS.has(call.name) || !call.args.length) continue;
    const arg = call.args[0];
    const parsed = parseObject(tokens, arg[0], bindings, source);
    if (!parsed) continue;
    let text = parsed.text;
    let partial = parsed.partial;
    const warnings = [...parsed.warnings],
      dynamic = [...parsed.interpolations];
    if (
      [
        "runcommand",
        "runcommandasync",
        "runcmd",
        "command",
        "runcommanddocument",
      ].includes(call.name)
    ) {
      if (!jsonShape(text)) continue;
    } else {
      const name = collectionName(tokens, call, calls, bindings);
      const owner = tokens[call.callee - 2]?.value || "";
      const mongoContext =
        !!name ||
        /(collection|mongo)/i.test(owner) ||
        tokens.some(
          (token) =>
            token.kind === "string" &&
            /mongodb|pymongo|mongo-driver|bson/i.test(token.value),
        ) ||
        /"\$[A-Za-z]/.test(parsed.text);
      if (!mongoContext) continue;
      if (!name) {
        partial = true;
        warnings.push(
          "Nome della collezione non risolto staticamente: sostituire il marcatore prima dell’uso.",
        );
        dynamic.push({ name: "collection", placeholder: "{{COLLECTION}}" });
      }
      const field = call.name === "aggregate" ? "pipeline" : "filter";
      if (
        (field === "pipeline" && !text.startsWith("[")) ||
        (field === "filter" && !text.startsWith("{"))
      ) {
        partial = true;
        warnings.push(
          "L’argomento del driver deve essere ricostruito come documento JSON.",
        );
      }
      text = `{${JSON.stringify(call.name === "aggregate" ? "aggregate" : "find")}:${JSON.stringify(name || "{{COLLECTION}}")},${JSON.stringify(field)}:${text}${call.name === "aggregate" ? ',"cursor":{}' : call.name === "findone" ? ',"limit":1' : ""}}`;
      if (tokens[call.end + 1]?.value === ".") {
        const method = normalize(tokens[call.end + 2]?.value || "");
        if (!["toarray", "collect", "await", "tolist"].includes(method)) {
          partial = true;
          warnings.push(
            "La catena di opzioni dopo il comando non è stata ricostruita; verificare limite, ordinamento e proiezione.",
          );
        }
      }
    }
    if (jsonShape(text))
      emit(
        "mongodb",
        text,
        parsed.start,
        parsed.end,
        partial,
        warnings,
        `Documento letterale in ${tokens[call.callee].value}`,
        dynamic,
        call.name === "aggregate"
          ? "Aggregazione MongoDB"
          : "Operazione MongoDB",
      );
  }
  result.operations.sort(
    (left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine,
  );
  if (result.truncated)
    result.warnings.push(
      `Mostrate le prime ${maximum} istruzioni; altre estrazioni sono state omesse.`,
    );
  if (!result.operations.length)
    result.warnings.push(
      "Nessuna istruzione database letterale riconosciuta. Codice generico, commenti, query costruite altrove e valori dinamici non vengono inventati.",
    );
  return result;
}
