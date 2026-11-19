// Every CARRIED column that can hold an actor id, and what keeps a temporary session's id out of it (docs/architecture/proposals/sessions-reads-own-2026-11-17.md §2b).
//
// Carried = a column of a table in the snapshot list (spine/snapshotTables.json) that is neither excluded nor overridden there: it goes to the
// person's other nodes in snapshots and change bundles. "Can hold an actor id" = it references actors(id), or its name says so (actor_id, *_by,
// *_actor_id, author*, created_by*). The list is read from the database's own catalog, so a new such column fails this test until it is classified.
// What travels is checked on the wire by sessionsStayOnTheirNodeWrites.integration.test.ts (the session walks every write route).
//
// SAFETY: only runs against a *_test database (reads the catalog only); skips otherwise.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";

/** Why a session's id is not in the column. */
type Why =
  | "never-leaves"   // the rows of a session never leave the node (snapshotTables.json neverLeaves; guards/neverLeaves.guard.test.ts)
  | "personal"       // a personal row: keyed by the writer, and a session's personal writes are refused (spine/mutate.ts mutatePersonal: own_personal)
  | "person-only"    // only a person's operation writes it (requirePerson / the owner)
  | "agent-only"     // only an AI's operation writes it
  | "carried-actor"; // written through spine/authority.ts carriedActorId: null for a session

const CLASSIFIED: Record<string, { why: Why; note: string }> = {
  "actors.id": { why: "never-leaves", note: "a session's actors row (type 'session')" },
  "space_members.actor_id": { why: "never-leaves", note: "a session's seats, and their tombstones" },
  "workspaces.owner_actor_id": { why: "person-only", note: "the owner is a person (services/ownerTransfer.ts)" },
  "spaces.owner_actor_id": { why: "person-only", note: "a personal space's owner is a person; a shared space has none" },
  "function_refs.created_by": { why: "carried-actor", note: "a card, a view, a function (services/functionRefs.ts insertOwnRef / insertView / addFunction), and a restore (services/backupExtras.ts importFunctionRefs)" },
  "rss_subscriptions.created_by_actor_id": { why: "carried-actor", note: "a feed (modules/rss/sources.ts createSource; subscribing is also personal: mutatePersonal) and a move (services/backupExtras.ts importExtras)" },
  "ai_edit_suggestions.agent_actor_id": { why: "agent-only", note: "the AI that proposed it" },
  "ai_edit_suggestion_items.decided_by": { why: "carried-actor", note: "deciding is a person's (routes/aiSuggestions.ts requirePerson); written through carriedActorId all the same" },
  "actor_module_settings.actor_id": { why: "personal", note: "review settings per tag" },
  "actor_prefs.actor_id": { why: "personal", note: "preferences" },
  "review_states.actor_id": { why: "personal", note: "review progress" },
  "focus_sessions.actor_id": { why: "personal", note: "focus records" },
  "rss_mutes.actor_id": { why: "personal", note: "mutes" },
  "rss_seen.actor_id": { why: "personal", note: "what was read" },
  "external_calendars.actor_id": { why: "personal", note: "a person's calendars" },
};

const NAMED_LIKE_AN_ACTOR = /^(actor_id|author.*|created_by.*|.*_by|.*_actor_id)$/;

// one pool for the file (guards/testFileTeardown.guard.test.ts)
afterAll(async () => { await pool.end(); });

describe.skipIf(!isTestDatabase())("carried columns that can hold an actor id", () => {

  it("are exactly the classified list (read from the catalog: a new one fails until it is classified)", async () => {
    const tables = SNAPSHOT_SPECS.map((s) => s.table);
    const columns = (await q<{ table_name: string; column_name: string; refs_actors: boolean }>(
      `SELECT c.table_name, c.column_name,
              EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                        JOIN information_schema.referential_constraints r ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema
                        JOIN information_schema.constraint_column_usage u ON u.constraint_name = r.unique_constraint_name AND u.constraint_schema = r.unique_constraint_schema
                       WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name
                         AND u.table_name = 'actors' AND u.column_name = 'id') AS refs_actors
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = ANY($1::text[])`, [tables])).rows;
    const carried = (table: string, column: string) => {
      const spec = SNAPSHOT_SPECS.find((s) => s.table === table)!;
      return !(spec.exclude ?? []).includes(column) && !Object.keys(spec.override?.({ nodeRow: () => "true", node: () => "true", space: () => "true", person: () => "true" }) ?? {}).includes(column);
    };
    const found = columns
      .filter((c) => carried(c.table_name, c.column_name) && (c.refs_actors || NAMED_LIKE_AN_ACTOR.test(c.column_name)))
      .map((c) => `${c.table_name}.${c.column_name}`);
    // actors.id is the actor itself (its own key): listed by hand, the catalog has no reference to itself
    expect([...new Set([...found, "actors.id"])].sort(), "a carried column that can hold an actor id: say in CLASSIFIED what keeps a session's id out of it").toEqual(Object.keys(CLASSIFIED).sort());
    expect(found, "control: the catalog query finds the references").toEqual(expect.arrayContaining(["space_members.actor_id", "function_refs.created_by"]));
  });
});

/* ------------------------------------------------------------------ */
/* Every place that writes a "carried-actor" column, found in the code */
/* ------------------------------------------------------------------ */

const SRC = join(import.meta.dirname, "..");
const CARRIED_ACTOR = Object.entries(CLASSIFIED).filter(([, c]) => c.why === "carried-actor").map(([key]) => { const [table, column] = key.split("."); return { table: table!, column: column! }; });

function productionFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : productionFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".generated.ts") ? [path] : [];
  });
}

type Site = { site: string; value: string; through: boolean };

/** The value is carriedActorId(<the writer>), optionally only when there is a writer (`by ? carriedActorId(by) : null`). */
const throughTheRule = (value: string) => /^(?:[\w.]+\s*\?\s*)?carriedActorId\([\w.]+\)(?:\s*:\s*null)?$/.test(value.replace(/\s+/g, " ").trim());

/** Every write of `table`.`column` in one file's text: a query builder `.values({ column: … })` / `.set({ column: … })` whose receiver is
 *  insertInto/updateTable of the table, or SQL text `INSERT INTO table (… column …) VALUES (… $n …)` / `UPDATE table SET … column = $n` with the
 *  parameter array beside it (the n-th element is the value). A write whose value cannot be found is reported with the value "?". */
function writesInText(file: string, text: string, table: string, column: string): Site[] {
  if (!text.includes(column)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (n: ts.Node) => `${relative(SRC, file)}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;
  const builder = new RegExp(`\\b(insertInto|updateTable)\\(\\s*["']${table}["']`);
  const insert = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`, "i");
  const update = new RegExp(`UPDATE ${table} SET (.*?)(?:\\bWHERE\\b|\\bRETURNING\\b|$)`, "i");
  const sites: Site[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === column) {
      const call = n.parent.parent;
      if (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ["values", "set"].includes(call.expression.name.text)
        && builder.test(call.expression.expression.getText(source))) {
        sites.push({ site: at(n), value: n.initializer.getText(source), through: throughTheRule(n.initializer.getText(source)) });
      }
    }
    const first = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    if (first && (ts.isNoSubstitutionTemplateLiteral(first) || ts.isStringLiteral(first) || ts.isTemplateExpression(first))) {
      const sql = first.getText(source).replace(/\s+/g, " ");
      const params = (n as ts.CallExpression).arguments[1];
      const elements = params && ts.isArrayLiteralExpression(params) ? params.elements : null;
      let placeholder: string | null | undefined;
      const ins = insert.exec(sql);
      if (ins) { const i = ins[1]!.split(",").map((c) => c.trim()).indexOf(column); if (i >= 0) placeholder = ins[2]!.split(",")[i]?.trim() ?? null; }
      const upd = update.exec(sql);
      if (upd) { const m = new RegExp(`\\b${column}\\s*=\\s*([^,]+)`).exec(upd[1]!); if (m) placeholder = m[1]!.trim(); }
      if (placeholder !== undefined) {
        const index = placeholder ? /^\$(\d+)/.exec(placeholder)?.[1] : undefined;
        const value = index && elements ? elements[Number(index) - 1] : undefined;
        sites.push({ site: at(n), value: value ? value.getText(source) : "?", through: !!value && throughTheRule(value.getText(source)) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return sites;
}

describe("every write of a carried \"who did this\" column goes through carriedActorId (found in the code, not listed by hand)", () => {
  const all = CARRIED_ACTOR.flatMap(({ table, column }) =>
    productionFiles().flatMap((f) => writesInText(f, readFileSync(f, "utf8"), table, column).map((s) => ({ ...s, column: `${table}.${column}` }))));

  it("finds the writes (control: the two restore writers and the ordinary ones are among them)", () => {
    const sites = all.map((s) => `${s.column} ${s.site.replace(/:\d+$/, "")}`);
    for (const expected of [
      "function_refs.created_by services/backupExtras.ts", "rss_subscriptions.created_by_actor_id services/backupExtras.ts",
      "function_refs.created_by services/functionRefs.ts", "rss_subscriptions.created_by_actor_id modules/rss/sources.ts",
      "ai_edit_suggestion_items.decided_by services/aiSuggestions.ts",
    ]) expect(sites, expected).toContain(expected);
  });

  it("each write records carriedActorId(the writer): never the writer's id itself, never a value the scan cannot read", () => {
    const bad = all.filter((s) => !s.through).map((s) => `${s.column} at ${s.site}: ${s.value}`);
    expect(bad, "write it as carriedActorId(actor) (spine/authority.ts): a temporary session records null").toEqual([]);
  });

  it("self-test: the scan reports a write of the actor's id in either form, and passes one through the rule", () => {
    const file = join(SRC, "services", "fixture.ts");
    const text = [
      "async function a(actor) { await db.insertInto(\"function_refs\").values({ id, created_by: actor.id }).execute(); }",
      "async function b(actor) { await q(`INSERT INTO rss_subscriptions (workspace_id, created_by_actor_id) VALUES ($1, $2)`, [ws, actor.id]); }",
      "async function c(actor) { await q(`UPDATE ai_edit_suggestion_items SET status = $2, decided_by = $3 WHERE id = $1`, [id, s, carriedActorId(actor)]); }",
      "async function d(actor) { await q(`INSERT INTO function_refs (id, created_by) VALUES ($1, $2)`, params); }",
    ].join("\n");
    expect(writesInText(file, text, "function_refs", "created_by")).toMatchObject([{ through: false, value: "actor.id" }, { through: false, value: "?" }]);
    expect(writesInText(file, text, "rss_subscriptions", "created_by_actor_id")).toMatchObject([{ through: false, value: "actor.id" }]);
    expect(writesInText(file, text, "ai_edit_suggestion_items", "decided_by")).toMatchObject([{ through: true }]);
  });
});
