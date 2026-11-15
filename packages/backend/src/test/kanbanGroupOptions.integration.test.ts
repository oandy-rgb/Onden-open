// Bug fix kanban-column-order-not-option-order: the saved-view exec endpoint
// now surfaces the group field's declared option order (select fields only)
// as `view.group_field_options`, so the Kanban layout can lay columns out in
// the schema's sequence (Lead → Qualified → Won) instead of row-insertion
// order. Pinned here: a select group field returns its options in order; a
// non-select group field and a no-group view return null.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import type { ActorCtx } from "../types.js";
import tagsRouter from "../routes/tags.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedView } from "./helpers/seedView.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

type ExecView = { group_by: string | null; group_field_options: string[] | null };

describe.skipIf(!isTestDb)("kanban group_field_options surfacing", () => {
  const STAMP = Date.now();
  let WS = "", tagId = "", selectViewId = "", textViewId = "", noGroupViewId = "";
  let adminId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    adminId = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,'human') RETURNING id`,
      [WS, `kgo admin ${STAMP}`])).rows[0]!.id;

    // A tag whose schema declares a select "stage" field (Lead→Qualified→Won)
    // plus a plain "notes" text field.
    tagId = (await seedClassTag(WS, {
      name: "KGO",
      slug: `kgo-${STAMP}`,
      title: `kgo-tag-${STAMP}`,
      nodeSlug: `kgo-tag-${STAMP}`,
      fields: [
        { name: "stage", type: "select", options: ["Lead", "Qualified", "Won"] },
        { name: "notes", type: "text" },
      ],
    })).tagId;

    const mkView = (name: string, groupBy: string | null) =>
      seedView(tagId, { name, layout: "kanban", visible_fields: ["title", "stage", "notes"], group_by: groupBy });
    selectViewId = await mkView("By stage", "stage");
    textViewId = await mkView("By notes", "notes");
    noGroupViewId = await mkView("Ungrouped", null);
  });

  async function execView(viewId: string): Promise<ExecView> {
    currentActor = { id: adminId, name: "A", role: "admin", type: "human" };
    const res = await app.request(`/api/tags/${tagId}/views/${viewId}/exec`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: ExecView };
    return body.view;
  }

  it("returns the select group field's options in declared order", async () => {
    const view = await execView(selectViewId);
    expect(view.group_by).toBe("stage");
    expect(view.group_field_options).toEqual(["Lead", "Qualified", "Won"]);
  });

  it("returns null for a non-select group field", async () => {
    const view = await execView(textViewId);
    expect(view.group_by).toBe("notes");
    expect(view.group_field_options).toBeNull();
  });

  it("returns null when the view has no group field", async () => {
    const view = await execView(noGroupViewId);
    expect(view.group_by).toBeNull();
    expect(view.group_field_options).toBeNull();
  });
});
