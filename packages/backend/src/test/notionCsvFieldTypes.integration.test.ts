// D51: a Notion CSV column is typed by the attribute value rule
// (@onden/markdown inferFieldType / toCalendarDate), and each cell is stored
// as its field stores it. The importer had its own date grammar: "October 16,
// 2026" made a date field whose values were all stored as text (typed sorts,
// date filters and the calendar skipped every row), and "2026-02-30" or
// "2026-10-16 (draft)" made a date column too.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("Notion CSV field types use the attribute value rule (D51)", () => {
  let WS = "";
  let admin: ActorCtx = { id: "d51-admin", name: "Admin", role: "admin", type: "human" };
  const stamp = Date.now();
  const db = `D51 Tasks ${stamp}`;
  const csv = [
    "Name,Due,Shipped,Bad day,Noted,Count,Amount,Done",
    `Alpha ${stamp},"October 16, 2026",10/16/2026,2026-10-16,2026-10-16,3,"1,200",Yes`,
    `Beta ${stamp},"October 2, 2026 3:04 PM",1/2/2026,2026-02-30,2026-10-16 (draft),-4.5,15,No`,
    "",
  ].join("\n");
  let fields: Array<{ name: string; type: string }> = [];
  const stored = new Map<string, { value: string; value_type: string }>();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    const result = await importNotionDatabases(WS, [{ path: `${db}.csv`, content: csv }], [], admin);
    expect(result).toMatchObject({ collections: 1, rows: 2, rowsSkipped: 0 });
    await awaitAllDispatchers();

    fields = (await q<{ fields: Array<{ name: string; type: string }> }>(
      `SELECT tag_schema->'fields' AS fields FROM content_nodes
        WHERE workspace_id = $1 AND node_type = 'class_tag' AND tag_schema->>'name' = $2 AND deleted_at IS NULL`,
      [WS, db])).rows[0]!.fields;
    const rows = await q<{ title: string; key: string; value: string; value_type: string }>(
      `SELECT n.title, a.key, a.value, a.value_type FROM node_attributes a JOIN content_nodes n ON n.id = a.node_id
        WHERE n.workspace_id = $1 AND n.title IN ($2, $3) AND n.deleted_at IS NULL`,
      [WS, `Alpha ${stamp}`, `Beta ${stamp}`]);
    for (const r of rows.rows) stored.set(`${r.title.split(" ")[0]}.${r.key}`, { value: r.value, value_type: r.value_type });
  });
  afterAll(async () => { await awaitAllDispatchers(); });

  it("types each column by every value", () => {
    expect(Object.fromEntries(fields.map((f) => [f.name, f.type]))).toEqual({
      Name: "text", Due: "date", Shipped: "date", "Bad day": "text", Noted: "text",
      Count: "number", Amount: "number", Done: "boolean",
    });
  });

  it("stores Notion's written dates as typed YYYY-MM-DD dates", () => {
    expect(stored.get("Alpha.Due")).toEqual({ value: "2026-10-16", value_type: "date" });
    expect(stored.get("Beta.Due")).toEqual({ value: "2026-10-02", value_type: "date" });
    expect(stored.get("Alpha.Shipped")).toEqual({ value: "2026-10-16", value_type: "date" });
    expect(stored.get("Beta.Shipped")).toEqual({ value: "2026-01-02", value_type: "date" });
  });

  it("keeps impossible or annotated dates as text", () => {
    expect(stored.get("Beta.Bad day")).toEqual({ value: "2026-02-30", value_type: "text" });
    expect(stored.get("Beta.Noted")).toEqual({ value: "2026-10-16 (draft)", value_type: "text" });
  });

  it("stores numbers and booleans typed", () => {
    expect(stored.get("Alpha.Amount")).toEqual({ value: "1200", value_type: "number" });
    expect(stored.get("Alpha.Count")).toEqual({ value: "3", value_type: "number" });
    expect(stored.get("Beta.Count")).toEqual({ value: "-4.5", value_type: "number" });
    expect(stored.get("Alpha.Done")).toEqual({ value: "true", value_type: "bool" });
    expect(stored.get("Beta.Done")).toEqual({ value: "false", value_type: "bool" });
  });
});
