// Counts, per core table, how many production files write it and how many read it through SQL text, and how many
// files import the raw event() from db.ts. Used by nodeStoreOwnership.guard.test.ts; the plan it serves is
// docs/architecture/proposals/node-store-ownership-2026-11-14.md.
// Text matching on purpose (fast, no TypeScript program): a file counts when its code (comments removed) names the
// table after a write verb or a read keyword, in raw SQL (`UPDATE content_nodes`) or in Kysely (`updateTable("content_nodes")`).
// It cannot see a table name built at run time (`sqlIdentifier(...)`); those are rare and listed in the plan.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const TABLES = ["content_nodes", "node_attributes", "node_tags", "block_nodes", "domain_events"] as const;
export type CoreTable = (typeof TABLES)[number];

/** Production source: not tests, not the generated schema, not vendored code. */
export function productionFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "test" || name === "vendor" ? [] : productionFiles(full);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "dbSchema.generated.ts") return [];
    return [full];
  });
}

export const rel = (file: string): string => relative(SRC, file).split("\\").join("/");

/** Comments removed (a `//` inside a string such as a URL is kept: only `//` at line start or after whitespace counts). */
export function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

const NAME = String.raw`(?:"?[a-z_][\w$]*"?\s*\.\s*)?"?TABLE"?(?![\w$])`;
const named = (table: string, prefix: string) => `${prefix}${NAME.replace("TABLE", table)}`;
const KYSELY_NAME = (table: string) => String.raw`\(\s*["'\`]${table}(?:\s+as\s+\w+)?["'\`]`;

const writeRe = (table: string) =>
  new RegExp(
    String.raw`(?<![\w$])(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?(?:\s+only)?)\s+(?:only\s+)?${named(table, "")}` +
      String.raw`|\.(?:insertInto|updateTable|deleteFrom)${KYSELY_NAME(table)}`,
    "i",
  );
// `delete from t` is a write, so a bare `from` right after `delete` is not a read.
const readRe = (table: string) =>
  new RegExp(
    String.raw`(?<!delete\s+)(?<![\w$])(?:from|join)\s+(?:only\s+)?${named(table, "")}` +
      String.raw`|\.(?:selectFrom|innerJoin|leftJoin|rightJoin|fullJoin|leftJoinLateral|innerJoinLateral)${KYSELY_NAME(table)}`,
    "i",
  );

export interface TableUse { writers: string[]; readers: string[] }

/** Importers of the raw `event` from db.ts (a named import, also `event as x`; `import type` is ignored). */
export function rawEventImporters(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      if (/^import\s+type/.test(m[0])) continue;
      const target = join(dirname(join(SRC, file)), m[2]!).replace(/\.js$/, "");
      if (target !== join(SRC, "db")) continue;
      if (m[1]!.split(",").some((part) => /^\s*event(\s+as\s+\w+)?\s*$/.test(part))) out.push(file);
    }
  }
  return out.sort();
}

export function scan(): { tables: Record<CoreTable, TableUse>; rawEventImporters: string[] } {
  const files = new Map(productionFiles().map((f) => [rel(f), code(readFileSync(f, "utf8"))]));
  const tables = {} as Record<CoreTable, TableUse>;
  for (const table of TABLES) {
    const w = writeRe(table);
    const r = readRe(table);
    const writers: string[] = [];
    const readers: string[] = [];
    for (const [file, text] of files) {
      if (w.test(text)) writers.push(file);
      if (r.test(text)) readers.push(file);
    }
    tables[table] = { writers: writers.sort(), readers: readers.sort() };
  }
  return { tables, rawEventImporters: rawEventImporters(files) };
}
