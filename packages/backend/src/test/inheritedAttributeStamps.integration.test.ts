// What a new note inherits when it is made (a parent's `child:` values, the parent's site default, a tag's field defaults) is
// written as source 'derived', which the node_attributes stamp trigger leaves alone. These values cannot be worked out again
// by another node (the parent or the schema may have changed since), so they are stamped when the note is made, and a removal
// leaves a tombstone (causal-stamps proposal §4.1, node_attributes). Through the real routes.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { persistActor } from "./helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");
const NATIVE = { origin: "http://localhost" };
const req = (path: string, init: { method?: string; json?: unknown } = {}) => Promise.resolve(app.request(path, {
  method: init.method ?? "GET", headers: { ...NATIVE, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
  body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
}));

const PREVIEW_UNSTAMPED_ATTRIBUTES = `
  SELECT CASE
           WHEN a.source IN ('ui', 'explicit', 'dispatcher') THEN 'written by a person or automation (waits for the genesis stamp)'
           WHEN a.source = 'derived' AND a.key IN ('_published', '_published_by_parent') THEN 'derived: site default'
           WHEN a.source = 'derived' AND a.key LIKE '\\_%' THEN 'derived: other system key'
           WHEN a.source = 'derived' THEN 'derived: other key (child: copy, field default, computed)'
           ELSE 'text-produced (markdown, frontmatter): never stamped'
         END AS kind,
         count(*)::int AS n
    FROM node_attributes a
   WHERE NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = a.workspace_id AND s.table_name = 'node_attributes'
                        AND s.row_key = a.node_id::text || '/' || a.key AND s.field = '*')
   GROUP BY 1 ORDER BY 1`;

describe.skipIf(!isTestDb)("attributes a new note inherits are stamped", () => {
  let ws = "";
  let space = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
  });

  const create = async (body: Record<string, unknown>) => {
    const res = await req("/api/nodes", { method: "POST", json: { space_id: space, title: `inh ${Date.now()}`, markdown: "x", ...body } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const stampOf = async (nodeId: string, key: string) => (await q<{ deleted: boolean; author: string | null }>(
    `SELECT deleted, author FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2 AND field = '*'`,
    [ws, `${nodeId}/${key}`])).rows[0] ?? null;
  const sourceOf = async (nodeId: string, key: string) => (await q<{ source: string }>(
    `SELECT source FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0]?.source ?? null;

  it("a parent's child: value copied onto a new note has a stamp with its author, and removing it leaves a tombstone", async () => {
    const parent = await create({});
    expect((await req(`/api/nodes/${parent}/attributes/${encodeURIComponent("child:status")}`, { method: "PUT", json: { value: "todo" } })).status).toBe(200);
    const child = await create({ parent_id: parent });
    expect(await sourceOf(child, "status")).toBe("derived"); // the source is unchanged: ranking and export read it
    expect(await stampOf(child, "status")).toMatchObject({ deleted: false });
    expect((await stampOf(child, "status"))!.author).not.toBeNull();
    expect((await req(`/api/nodes/${child}/attributes/status`, { method: "DELETE" })).status).toBe(200);
    expect(await stampOf(child, "status")).toMatchObject({ deleted: true });
  });

  it("the site default a note takes from a parent that is not published is stamped, and clearing its mark leaves a tombstone", async () => {
    const parent = await create({});
    expect((await req(`/api/nodes/${parent}/attributes/_published`, { method: "PUT", json: { value: "false" } })).status).toBe(200);
    const child = await create({ parent_id: parent });
    expect(await sourceOf(child, "_published_by_parent")).toBe("derived");
    expect(await stampOf(child, "_published")).toMatchObject({ deleted: false });
    expect(await stampOf(child, "_published_by_parent")).toMatchObject({ deleted: false });
    // a person's own say on the note drops the mark
    expect((await req(`/api/nodes/${child}/attributes/_published`, { method: "PUT", json: { value: "true" } })).status).toBe(200);
    expect(await stampOf(child, "_published_by_parent")).toMatchObject({ deleted: true });
  });

  it("a tag's field default seeded on a note is stamped", async () => {
    const pack = await req("/api/tags/import", { method: "POST", json: { name: `inh-tag-${Date.now()}`, fields: [{ name: "rating", type: "number", default: "3" }] } });
    expect(pack.status).toBe(201);
    const tagId = ((await pack.json()) as { id: string }).id;
    const note = await create({});
    expect((await req(`/api/nodes/${note}/tags/${tagId}`, { method: "PUT", json: {} })).status).toBe(200);
    expect(await sourceOf(note, "rating")).toBe("derived");
    expect(await stampOf(note, "rating")).toMatchObject({ deleted: false });
  });

  it("the stamp is in the write's transaction: a creation that fails after it leaves no stamp and no row", async () => {
    const note = await create({});
    const actor = await persistActor(ws, { id: "", name: "Inherit Rollback", role: "admin", type: "human" });
    await expect(withEventTransaction(ws, async () => {
      await recordAttributeChange({
        workspaceId: ws, nodeId: note, key: "inherited_rollback", actor, next: { value: "x", source: "derived" }, rule: "absent",
        inheritedAtCreation: true, authority: { kind: "open", why: "test: a write that is rolled back" }, uiContext: "test",
      });
      expect(await stampOf(note, "inherited_rollback")).toMatchObject({ deleted: false }); // there inside the transaction
      throw new Error("fails after the stamp");
    })).rejects.toThrow("fails after the stamp");
    expect(await stampOf(note, "inherited_rollback")).toBeNull();
    expect(await sourceOf(note, "inherited_rollback")).toBeNull();
  });

  // The read-only preview for the production check (PR description): how many attribute rows have no stamp, by kind. It
  // returns counts only; run here so the text in the PR is known to execute.
  it("the preview query of rows with no stamp returns counts by kind", async () => {
    const parent = await create({});
    await req(`/api/nodes/${parent}/attributes/${encodeURIComponent("child:status")}`, { method: "PUT", json: { value: "todo" } });
    const child = await create({ parent_id: parent });
    await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2`, [ws, `${child}/status`]);
    const rows = (await q<{ kind: string; n: number }>(PREVIEW_UNSTAMPED_ATTRIBUTES)).rows;
    expect(rows.every((r) => typeof r.kind === "string" && Number.isInteger(r.n))).toBe(true);
    expect(rows.find((r) => r.kind === "derived: other key (child: copy, field default, computed)")!.n).toBeGreaterThan(0);
  });
});
