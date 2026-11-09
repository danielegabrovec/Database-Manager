import type { Engine, TableInfo, SchemaSnapshot } from "../types";
import { quoteIdentifier } from "../components/SchemaBuilders";
export type OperationKind =
  | "select"
  | "findByKey"
  | "filter"
  | "join"
  | "aggregate"
  | "insert"
  | "update"
  | "delete"
  | "custom";
export interface ReadFilter {
  column: string;
  operator: string;
  value: string;
}
export interface ReadOptions {
  operation: OperationKind;
  columns: string[];
  filters: ReadFilter[];
  orderBy: string;
  descending: boolean;
  limit: number;
  joinTable: string;
  joinLocal: string;
  joinForeign: string;
  joinType: "INNER" | "LEFT";
  aggregate: string;
  aggregateColumn: string;
  groupBy: string[];
  custom: string;
}
export interface WorkbenchParameter {
  name: string;
  dataType: string;
  nullable: boolean;
  value: unknown;
}
export const INITIAL_READ: ReadOptions = {
  operation: "select",
  columns: [],
  filters: [],
  orderBy: "",
  descending: false,
  limit: 100,
  joinTable: "",
  joinLocal: "",
  joinForeign: "",
  joinType: "LEFT",
  aggregate: "COUNT",
  aggregateColumn: "*",
  groupBy: [],
  custom: "",
};
export function buildOperation(
  engine: Engine,
  table: TableInfo,
  schema: SchemaSnapshot | null,
  o: ReadOptions,
): {
  query: string;
  parameters: WorkbenchParameter[];
  lesson: string;
  template?: string;
} {
  const q = (n: string) => quoteIdentifier(n, engine);
  const qualified = (t: TableInfo) =>
    t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  const parameters: WorkbenchParameter[] = [];
  const bind = (column: string, value: unknown) => {
    const name = `p${parameters.length + 1}`;
    const type =
      table.columns.find((c) => c.name === column)?.dataType || "TEXT";
    if (typeof value === "string" && /bool/i.test(type)) {
      if (!["true", "false", "1", "0"].includes(value.toLowerCase()))
        throw new Error("Il filtro booleano richiede true o false.");
      value = ["true", "1"].includes(value.toLowerCase());
    } else if (typeof value === "string" && /int/i.test(type)) {
      if (!/^-?\d+$/.test(value))
        throw new Error("Il filtro intero richiede un numero intero.");
      const n = Number(value);
      if (Number.isSafeInteger(n)) value = n;
    } else if (typeof value === "string" && /real|float|double/i.test(type)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error("Inserisci un numero finito.");
      value = n;
    }
    parameters.push({ name, dataType: type, nullable: false, value });
    return engine === "postgresql" ? `$${parameters.length}` : `:${name}`;
  };
  const cols = o.columns.length ? o.columns : table.columns.map((c) => c.name);
  for (const c of cols)
    if (!table.columns.some((v) => v.name === c))
      throw new Error(`Campo sconosciuto: ${c}`);
  for (const name of o.groupBy) {
    if (!table.columns.some((c) => c.name === name))
      throw new Error(`Campo di raggruppamento sconosciuto: ${name}`);
  }
  if (
    o.orderBy &&
    !table.columns.some((c) => c.name === o.orderBy) &&
    !(o.operation === "aggregate" && o.orderBy === "totale")
  )
    throw new Error("Campo di ordinamento sconosciuto.");
  if (
    o.operation === "aggregate" &&
    o.aggregateColumn !== "*" &&
    !table.columns.some((c) => c.name === o.aggregateColumn)
  )
    throw new Error("Campo di aggregazione sconosciuto.");
  const keys = table.columns.filter((c) => c.primaryKey);
  if (o.operation === "custom") {
    if (!o.custom.trim()) throw new Error("Apri prima una query nell’editor.");
    return {
      query: o.custom,
      parameters,
      lesson:
        "La query personalizzata viene inserita nel codice del driver. Dichiara esplicitamente i parametri che utilizzi.",
    };
  }
  if (engine === "mongodb") {
    const sample = (name: string, input?: string): unknown => {
      const type =
        table.columns.find((c) => c.name === name)?.dataType.toLowerCase() ||
        "string";
      const text =
        input ??
        (type.includes("objectid")
          ? "507f1f77bcf86cd799439011"
          : /int|long|decimal|double|number/.test(type)
            ? "1"
            : /bool/.test(type)
              ? "true"
              : "chiave");
      if (type.includes("objectid")) {
        if (!/^[a-fA-F0-9]{24}$/.test(text))
          throw new Error("ObjectId: inserisci 24 caratteri esadecimali.");
        return { $oid: text };
      }
      if (type === "long" || type.includes("int64")) {
        if (!/^-?\d+$/.test(text))
          throw new Error("Inserisci un intero per il filtro.");
        return { $numberLong: text };
      }
      if (type === "int" || type.includes("int32")) {
        if (
          !/^-?\d+$/.test(text) ||
          Number(text) < -2147483648 ||
          Number(text) > 2147483647
        )
          throw new Error("Intero Int32 non valido.");
        return { $numberInt: text };
      }
      if (/bool/.test(type)) {
        if (!["true", "false"].includes(text.toLowerCase()))
          throw new Error("Il filtro booleano richiede true o false.");
        return text.toLowerCase() === "true";
      }
      if (/decimal/.test(type)) return { $numberDecimal: text };
      if (/double|float|number/.test(type)) {
        const n = Number(text);
        if (!Number.isFinite(n)) throw new Error("Inserisci un numero finito.");
        return n;
      }
      return text;
    };
    const filter: Record<string, unknown> = {},
      templateFilter: Record<string, unknown> = {};
    const addCondition = (
      target: Record<string, unknown>,
      name: string,
      condition: unknown,
    ) => {
      if (name.startsWith("$") || name.includes("."))
        throw new Error(
          "Per campi MongoDB con $ o punti usa una query personalizzata con $getField.",
        );
      if (Array.isArray(target.$and)) {
        (target.$and as unknown[]).push({ [name]: condition });
      } else if (Object.prototype.hasOwnProperty.call(target, name)) {
        const previous = { ...target };
        for (const key of Object.keys(target)) delete target[key];
        target.$and = [previous, { [name]: condition }];
      } else {
        target[name] = condition;
      }
    };
    const mongoBind = (name: string, value: unknown) => {
      const key = `p${parameters.length + 1}`;
      parameters.push({
        name: key,
        dataType:
          table.columns.find((c) => c.name === name)?.dataType || "string",
        nullable: false,
        value,
      });
      return { $param: key };
    };
    if (o.operation === "findByKey") {
      const key = keys[0]?.name || "_id";
      const v = sample(key);
      filter[key] = v;
      templateFilter[key] = mongoBind(key, v);
    }
    for (const f of o.filters) {
      if (!table.columns.some((c) => c.name === f.column))
        throw new Error("Scegli un campo del documento.");
      if (f.operator === "IS NULL") {
        addCondition(filter, f.column, null);
        addCondition(templateFilter, f.column, null);
        continue;
      }
      if (f.operator === "IS NOT NULL") {
        addCondition(filter, f.column, { $ne: null, $exists: true });
        addCondition(templateFilter, f.column, { $ne: null, $exists: true });
        continue;
      }
      const v = f.operator === "LIKE" ? f.value : sample(f.column, f.value);
      const marker = mongoBind(f.column, v);
      const op = (
        {
          "!=": "$ne",
          ">": "$gt",
          ">=": "$gte",
          "<": "$lt",
          "<=": "$lte",
          LIKE: "$regex",
        } as Record<string, string>
      )[f.operator];
      addCondition(filter, f.column, op ? { [op]: v } : v);
      addCondition(templateFilter, f.column, op ? { [op]: marker } : marker);
    }
    const make = (f: Record<string, unknown>) => {
      if (o.operation === "aggregate") {
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(o.aggregate))
          throw new Error("Funzione non valida.");
        if (
          o.aggregate !== "COUNT" &&
          !table.columns.some((c) => c.name === o.aggregateColumn)
        )
          throw new Error("Scegli un campo per il calcolo.");
        return {
          aggregate: table.name,
          pipeline: [
            ...(Object.keys(f).length ? [{ $match: f }] : []),
            {
              $group: {
                _id: o.groupBy[0] ? `$${o.groupBy[0]}` : null,
                total:
                  o.aggregate === "COUNT"
                    ? { $sum: 1 }
                    : {
                        [`$${o.aggregate.toLowerCase()}`]: `$${o.aggregateColumn}`,
                      },
              },
            },
          ],
          cursor: {},
        };
      }
      return {
        find: table.name,
        filter: f,
        projection: o.columns.length
          ? Object.fromEntries(o.columns.map((c) => [c, 1]))
          : undefined,
        sort: o.orderBy ? { [o.orderBy]: o.descending ? -1 : 1 } : undefined,
        limit: Math.max(1, Math.min(10000, o.limit || 100)),
      };
    };
    return {
      query: JSON.stringify(make(filter), null, 2),
      template: JSON.stringify(make(templateFilter), null, 2),
      parameters,
      lesson:
        "MongoDB usa filtri e pipeline. Il codice generato sostituisce i marcatori $param con valori tipizzati, senza concatenare testo.",
    };
  }
  const where: string[] = [];
  if (
    o.operation === "findByKey" ||
    o.operation === "update" ||
    o.operation === "delete"
  ) {
    if (!keys.length)
      throw new Error(
        "Questa operazione richiede una chiave primaria stabile.",
      );
    for (const c of keys)
      where.push(
        `${q(c.name)} = ${bind(c.name, c.dataType.toUpperCase().includes("INT") ? 1 : "chiave")}`,
      );
  }
  for (const f of o.filters) {
    if (!table.columns.some((c) => c.name === f.column))
      throw new Error("Scegli una colonna del filtro.");
    if (
      ![
        "=",
        "!=",
        ">",
        ">=",
        "<",
        "<=",
        "LIKE",
        "IS NULL",
        "IS NOT NULL",
      ].includes(f.operator)
    )
      throw new Error("Operatore non valido.");
    where.push(
      `${o.operation === "join" ? "t." : ""}${q(f.column)} ${f.operator}${f.operator.includes("NULL") ? "" : ` ${bind(f.column, f.value)}`}`,
    );
  }
  let query = "";
  if (o.operation === "insert") {
    const fields = table.columns.filter((c) => !c.primaryKey);
    if (!fields.length)
      throw new Error("Non ci sono campi da inserire oltre alla chiave.");
    query = `INSERT INTO ${qualified(table)} (${fields.map((c) => q(c.name)).join(", ")}) VALUES (${fields.map((c) => bind(c.name, c.dataType.toUpperCase().includes("INT") ? 0 : "valore")).join(", ")});`;
  } else if (o.operation === "update") {
    const fields = table.columns.filter(
      (c) => !c.primaryKey && cols.includes(c.name),
    );
    if (!fields.length)
      throw new Error("Scegli almeno un campo da modificare.");
    query = `UPDATE ${qualified(table)} SET ${fields.map((c) => `${q(c.name)} = ${bind(c.name, "nuovo valore")}`).join(", ")} WHERE ${where.join(" AND ")};`;
  } else if (o.operation === "delete")
    query = `DELETE FROM ${qualified(table)} WHERE ${where.join(" AND ")};`;
  else {
    let projection = cols.length
      ? cols.map((c) => (o.operation === "join" ? "t." : "") + q(c)).join(", ")
      : "*";
    let from = qualified(table);
    if (o.operation === "join") {
      const other = schema?.tables.find((t) => t.name === o.joinTable);
      if (!other || !o.joinLocal || !o.joinForeign)
        throw new Error("Scegli tabella e campi della relazione.");
      if (
        !table.columns.some((c) => c.name === o.joinLocal) ||
        !other.columns.some((c) => c.name === o.joinForeign)
      )
        throw new Error("La relazione usa campi non presenti nello schema.");
      from += ` AS t\n${o.joinType === "INNER" ? "INNER" : "LEFT"} JOIN ${qualified(other)} AS j ON t.${q(o.joinLocal)} = j.${q(o.joinForeign)}`;
      const aliases = new Set(cols);
      projection += `, ${other.columns
        .filter((c) => !c.primaryKey)
        .slice(0, 3)
        .map((c) => {
          const base = other.name + "_" + c.name;
          let alias = base,
            suffix = 2;
          while (aliases.has(alias)) alias = base + "_" + suffix++;
          aliases.add(alias);
          return `j.${q(c.name)} AS ${q(alias)}`;
        })
        .join(", ")}`;
      projection = projection.replace(/, $/, "");
    }
    if (o.operation === "aggregate") {
      if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(o.aggregate))
        throw new Error("Funzione di aggregazione non valida.");
      if (
        o.aggregate !== "COUNT" &&
        !table.columns.some((c) => c.name === o.aggregateColumn)
      )
        throw new Error("Scegli un campo per il calcolo.");
      if (o.orderBy && o.orderBy !== "totale" && !o.groupBy.includes(o.orderBy))
        throw new Error("Ordina per un campo raggruppato oppure per totale.");
      const agg =
        o.aggregate === "COUNT" && o.aggregateColumn === "*"
          ? "*"
          : q(o.aggregateColumn);
      projection = [
        ...o.groupBy.map(q),
        `${o.aggregate}(${agg}) AS ${q("totale")}`,
      ].join(", ");
    }
    query = `SELECT ${projection}\nFROM ${from}`;
    if (where.length) query += `\nWHERE ${where.join(" AND ")}`;
    if (o.operation === "aggregate" && o.groupBy.length)
      query += `\nGROUP BY ${o.groupBy.map(q).join(", ")}`;
    if (o.orderBy)
      query += `\nORDER BY ${o.operation === "join" ? "t." : ""}${q(o.orderBy)} ${o.descending ? "DESC" : "ASC"}`;
    query += `\nLIMIT ${Math.max(1, Math.min(10000, o.limit || 100))};`;
  }
  return {
    query,
    parameters,
    lesson:
      o.operation === "join"
        ? "JOIN collega le righe tramite una relazione. I nomi delle colonne sono qualificati e i filtri restano parametri."
        : o.operation === "aggregate"
          ? "GROUP BY crea gruppi; COUNT/SUM/AVG/MIN/MAX producono un valore per gruppo. Le altre colonne selezionate devono appartenere al raggruppamento."
          : o.operation === "select" ||
              o.operation === "filter" ||
              o.operation === "findByKey"
            ? "La lettura restituisce le colonne scelte. I valori dei filtri vengono passati separatamente dal testo SQL, senza concatenazione."
            : "Questa operazione modifica i dati. Il generatore produce una bozza da revisionare; nessun comando viene eseguito automaticamente.",
  };
}
