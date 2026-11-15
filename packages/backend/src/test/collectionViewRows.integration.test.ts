// Four faults of a saved view's query, against a real database:
//   1. a row carries created_at (a calendar "Created date" placed no row),
//   2. a date filter value or stored date that is no date never fails the query,
//   3. paging has a unique tail key, so "load more" neither repeats nor skips,
//   4. the grouping field is filled whether or not the view shows it.
// Every row is made here and every query names its own tag, so the test does not
// depend on what another file left in the shared database.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { executeView, placementFields, type ExecOptions } from "../services/collectionViewQuery.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("collection view rows", () => {
  const STAMP = `cvr${Date.now()}`;
  let WS = "", tagId = "";
  const ids: string[] = [];
  const byTitle: Record<string, string> = {};

  async function addNote(title: string, attrs: Array<[string, string, string]> = []): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'') RETURNING id`,
      [WS, title, `${STAMP}-${ids.length}`],
    )).rows[0]!.id;
    ids.push(id);
    byTitle[title] = id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
    for (const [key, value, type] of attrs) {
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
         VALUES ($1,$2,$3,$4,$5,'explicit')`,
        [WS, id, key, value, type],
      );
    }
    return id;
  }
  const run = (over: Partial<Omit<ExecOptions, "tagId" | "parentId">> = {}) =>
    executeView({ workspaceId: WS, tagId, filters: [], sorts: [], visibleFields: ["title"], readableIds: ids, ...over });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    tagId = (await seedClassTag(WS, {
      name: "Rows", slug: `${STAMP}-tag`, title: `${STAMP}-tag`, nodeSlug: `${STAMP}-tag-node`,
      fields: [{ name: "due", type: "date" }, { name: "status", type: "text" }],
    })).tagId;
    await addNote("ok", [["due", "2026-06-10", "date"], ["status", "open", "text"]]);
    // A row written by other means than the app's write gate: typed 'date', not a date.
    await addNote("bad-day", [["due", "2026-02-30", "date"]]);
    await addNote("bad-tail", [["due", "2026-06-10abc", "date"]]);
    // Same title everywhere: only the tail key can order these.
    for (let i = 0; i < 5; i++) await addNote("same");
    await seedQ(`UPDATE content_nodes SET created_at = '2026-03-04T05:06:07.123Z' WHERE id = $1`, [byTitle.ok]);
  });

  it("a row carries created_at as an ISO instant, like updated_at", async () => {
    const { rows } = await run({ filters: [{ field: "title", op: "eq", value: "ok" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at).toBe("2026-03-04T05:06:07.123Z");
    expect(rows[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("a date range value that is no date matches nothing instead of failing the query", async () => {
    for (const value of ["2026-11-31", "2026-02-30", "2026-11-14abc"]) {
      const { rows, total } = await run({ filters: [{ field: "due", op: "gte", value }] });
      expect(rows, value).toEqual([]);
      expect(total, value).toBe(0);
    }
  });

  it("a stored date that is no date drops out of a range comparison instead of failing it", async () => {
    const { rows } = await run({ filters: [{ field: "due", op: "gte", value: "2026-01-01" }] });
    expect(rows.map((r) => r.id)).toEqual([byTitle.ok]);
    const before = await run({ filters: [{ field: "due", op: "lt", value: "2026-06-11" }] });
    expect(before.rows.map((r) => r.id)).toEqual([byTitle.ok]);
  });

  it("paging with equal sort values returns every row once", async () => {
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await run({ sorts: [{ field: "title", dir: "asc" }], limit: 2, offset });
      seen.push(...page.rows.map((r) => r.id));
      if (page.next === null) break;
      offset = page.next;
    }
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    const all = await run({ sorts: [{ field: "title", dir: "asc" }] });
    expect(seen).toEqual(all.rows.map((r) => r.id));
  });

  it("fills the grouping field of a view that does not show it", async () => {
    const hidden = await run({ visibleFields: ["title"], placementFields: placementFields({ group_by: "status" }) });
    expect(hidden.rows.find((r) => r.id === byTitle.ok)!.attributes).toEqual({ title: "ok", status: "open" });
    // Without the placement field the rows carry no value to group by.
    const plain = await run({ visibleFields: ["title"] });
    expect(plain.rows.find((r) => r.id === byTitle.ok)!.attributes.status).toBeUndefined();
  });

  it("fills a calendar's date field of a view that does not show it", async () => {
    const { rows } = await run({ visibleFields: ["title"], placementFields: placementFields({ layout_config: { date_field: "due" } }) });
    expect(rows.find((r) => r.id === byTitle.ok)!.attributes.due).toBe("2026-06-10");
  });
});

describe("placementFields", () => {
  it("lists the grouping, calendar date and gallery cover fields a view declares", () => {
    expect(placementFields({ group_by: "status", layout_config: { date_field: "due", cover_field: "img" } })).toEqual(["status", "due", "img"]);
    expect(placementFields({ group_by: null, layout_config: {} })).toEqual([]);
    expect(placementFields({ group_by: "", layout_config: { date_field: 7 } })).toEqual([]);
    expect(placementFields({})).toEqual([]);
  });
});
