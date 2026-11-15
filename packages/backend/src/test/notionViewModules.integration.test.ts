// D86: the Notion import seeds a collection's saved views (Table, Board on a
// select column, Calendar on a date column) through appendTagView — the same
// writer as POST /tags/:id/views. Views are always on (fix/views-always-on), so
// every layout is seeded whatever the workspace imported, and the stored
// element and COLLECTION_VIEW_CREATED event match createTagView's
// (inverse_op included).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { holderViewsSql } from "../services/functionRefSql.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { createTagView, viewCreateSchema } from "../services/tagViews.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { registerModuleEffects } from "../modules/index.js";
import { tableViewModule } from "../modules/table/index.js";
import { calendarViewModule } from "../modules/calendar/index.js";
import { kanbanViewModule } from "../modules/kanban/index.js";
import { galleryViewModule } from "../modules/gallery/index.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

type StoredView = Record<string, unknown> & { id: string; name: string; layout: string; group_by: string | null };

// A workspace of the file's own, so each import can set its module list
// without touching the shared 'default' workspace.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDb)("Notion import seeds only views whose module is imported (D86)", () => {
  let admin: ActorCtx = { id: "d86-admin", name: "Admin", role: "admin", type: "human" };
  const stamp = Date.now();
  const csv = (db: string) => [
    "Name,Status,Due",
    `${db} a,Todo,2026-10-16`,
    `${db} b,Done,2026-10-17`,
    `${db} c,Todo,2026-10-18`,
    "",
  ].join("\n");
  const setModules = (modules: string[] | null) =>
    setModulesOn(WS, modules);

  /** Import one database under `modules`; its tag id and stored views. */
  const importWith = async (modules: string[] | null, label: string) => {
    await setModules(modules);
    const db = `D86 ${label} ${stamp}`;
    const result = await importNotionDatabases(WS, [{ path: `${db}.csv`, content: csv(db) }], [], admin);
    expect(result).toMatchObject({ collections: 1, rows: 3, rowsSkipped: 0 });
    const row = (await q<{ id: string; views: StoredView[] | null }>(
      `SELECT id, ${holderViewsSql("content_nodes")} AS views FROM content_nodes
        WHERE workspace_id = $1 AND node_type = 'class_tag' AND tag_schema->>'name' = $2 AND deleted_at IS NULL`,
      [WS, db])).rows[0]!;
    return { tagId: row.id, views: row.views ?? [] };
  };
  const viewEvents = async (tagId: string) => (await q<{ target_id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
    `SELECT target_id, payload, tx_meta FROM domain_events
      WHERE workspace_id = $1 AND event_type = 'COLLECTION_VIEW_CREATED' AND payload->>'tag_id' = $2 ORDER BY id`,
    [WS, tagId])).rows;

  beforeAll(async () => {
    for (const mod of [tableViewModule, calendarViewModule, kanbanViewModule, galleryViewModule]) registerModuleEffects(mod);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D86 Notion views', $1) RETURNING id::text`,
      [`d86-notion-${randomUUID()}`])).rows[0]!.id;
    admin = await persistActor(WS, admin);
  });
  afterAll(async () => {
    await awaitAllDispatchers();
  });

  it("with every view module imported: Table, Board on the select column, Calendar — as before", async () => {
    const { views } = await importWith(["canvas", "table", "kanban", "calendar"], "all");
    expect(views.map((v) => [v.name, v.layout, v.group_by])).toEqual([
      ["Table", "table", null], ["Board", "kanban", "Status"], ["Calendar", "calendar", null],
    ]);
    expect(views[0]).toMatchObject({
      filters: [], sorts: [], visible_fields: ["Name", "Status", "Due"], layout_config: {}, pin_order: 0,
    });
    // The calendar's one setting is declared, not guessed from a field's name later: the import says which date column.
    expect(views[2]!.layout_config).toEqual({ date_field: "Due" });
  });

  it("views are always on: a workspace that imported no view module still gets all three", async () => {
    const { tagId, views } = await importWith(["canvas"], "none");
    expect(views.map((v) => v.layout)).toEqual(["table", "kanban", "calendar"]);
    expect((await viewEvents(tagId)).map((e) => e.payload.layout)).toEqual(["table", "kanban", "calendar"]);
  });

  it("the seeded view's element and event match createTagView's", async () => {
    const { tagId, views } = await importWith(null, "shape");
    const created = await createTagView(admin, WS, tagId, viewCreateSchema.parse({ name: `Extra ${stamp}`, layout: "table" }));
    expect(created).not.toBeNull();
    const stored = (await q<{ views: StoredView[] }>(`SELECT ${holderViewsSql("content_nodes")} AS views FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.views;
    const extra = stored.find((v) => v.id === created!.id)!;
    expect(Object.keys(views[0]!).sort()).toEqual(Object.keys(extra).sort());

    const events = await viewEvents(tagId);
    expect(events.map((e) => e.target_id)).toEqual([...views.map((v) => v.id), created!.id]);
    const seeded = events[0]!, manual = events[events.length - 1]!;
    expect(seeded.payload).toEqual({ tag_id: tagId, name: "Table", layout: "table" });
    expect(Object.keys(seeded.payload).sort()).toEqual(Object.keys(manual.payload).sort());
    expect(seeded.tx_meta).toEqual({ inverse_op: "collection_view.deleted", ui_context: "import.notion.view" });
    expect(manual.tx_meta).toEqual({ inverse_op: "collection_view.deleted", ui_context: "tag.view.create" });
  });
});
