// Undo of a body edit merges with later edits instead of overwriting them (D79).
// Undo applied the stored inverse patch to the CURRENT body with
// diff-match-patch's fuzzy patch_apply: when another writer had changed the
// same words, the hunk's context still matched, it reported "applied", and
// the other writer's text vanished — while the save-time merge (bodyMerge.ts,
// #312) already raised BODY_CONFLICT for the same situation. Undo now rebuilds
// the pre-event body from the event's own post blob and three-way merges.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");
const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

type Preview = { preview: { restored_body: string; can_apply_cleanly: boolean } };

describe.skipIf(!isTestDb)("undoing a body edit after later edits (D79)", () => {
  const stamp = Date.now();
  let defaultSpaceId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const workspaceId = await getWorkspaceId();
    await q(`INSERT INTO actors(workspace_id,name,type,external_id)
      VALUES($1,'System','agent','system')
      ON CONFLICT(workspace_id,external_id) DO NOTHING`, [workspaceId]);
    const systemId = (await q<{ id: string }>(
      `SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!.id;
    await joinDefaultSpace(workspaceId, systemId, "admin");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  async function note(title: string, markdown: string): Promise<string> {
    const res = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `${title} ${stamp}`, markdown } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  async function edit(id: string, markdown: string): Promise<string> {
    expect((await req(`/api/nodes/${id}`, { method: "PATCH", json: { markdown } })).status).toBe(200);
    return (await q<{ id: string }>(
      `SELECT id::text AS id FROM domain_events WHERE event_type='NODE_UPDATED' AND target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`, [id],
    )).rows[0]!.id;
  }
  const body = async (id: string) =>
    (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id=$1`, [id])).rows[0]!.markdown;
  const preview = async (eventId: string) =>
    ((await (await req(`/api/events/${eventId}/preview`)).json()) as Preview).preview;
  const restore = (eventId: string, json: Record<string, unknown> = {}) =>
    req(`/api/events/${eventId}/restore`, { method: "POST", json });

  it("refuses to overwrite another writer's edit of the same words (409, not 咖啡 → 牛奶)", async () => {
    const id = await note("d79 conflict", "Shopping list:\n- 買牛奶 today\n- eggs\n");
    const a = await edit(id, "Shopping list:\n- 買豆漿 today\n- eggs\n");
    await edit(id, "Shopping list:\n- 買咖啡 today\n- eggs\n");

    // The preview says what the restore will do: it needs force.
    expect(await preview(a)).toMatchObject({ can_apply_cleanly: false });
    const refused = await restore(a);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "patch_conflict" });
    expect(await body(id)).toBe("Shopping list:\n- 買咖啡 today\n- eggs\n");
    expect((await q(`SELECT 1 FROM domain_events WHERE event_type='NODE_UPDATED' AND tx_meta->>'restored_from'=$1`, [a])).rowCount).toBe(0);

    // force is the explicit overwrite: the undo's text wins on the conflicting
    // line, as the preview showed, and the result says so.
    const forcedPreview = (await preview(a)).restored_body;
    const forced = await restore(a, { force: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ restored: true, overwrote_later_edits: true });
    expect(await body(id)).toBe("Shopping list:\n- 買牛奶 today\n- eggs\n");
    expect(forcedPreview).toBe("Shopping list:\n- 買牛奶 today\n- eggs\n");
  });

  it("an edit that recorded no inverse patch is history_incomplete, not a restore that does nothing", async () => {
    const id = await note("d79 no inverse", "before\n");
    // A lone surrogate (possible through a JSON \\uD800 escape) has no encodable patch.
    const a = await edit(id, "after \uD800\n");
    const stored = (await q<{ p: string }>(`SELECT tx_meta->>'inverse_patch' AS p FROM domain_events WHERE id = $1::bigint`, [a])).rows[0]!.p;
    expect(stored).toBe("no-inverse-patch");
    const written = await body(id);
    const refused = await restore(a);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "history_incomplete" });
    expect(await body(id)).toBe(written);
  });

  it("merges cleanly with a later edit to other lines, keeping both", async () => {
    const id = await note("d79 clean", "第一行\n第二行\n第三行\n");
    const a = await edit(id, "第一行\n第二行（改）\n第三行\n");
    await edit(id, "第一行\n第二行（改）\n第三行，另一人補充\n");

    const p = await preview(a);
    expect(p).toMatchObject({ can_apply_cleanly: true, restored_body: "第一行\n第二行\n第三行，另一人補充\n" });
    const res = await restore(a);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("overwrote_later_edits");
    expect(await body(id)).toBe(p.restored_body);

    // The restore is itself undoable and brings the edit back, later line kept.
    const restoreEvent = (await q<{ id: string }>(
      `SELECT id::text AS id FROM domain_events WHERE event_type='NODE_UPDATED' AND tx_meta->>'restored_from'=$1`, [a])).rows[0]!.id;
    expect((await restore(restoreEvent)).status).toBe(200);
    expect(await body(id)).toBe("第一行\n第二行（改）\n第三行，另一人補充\n");
  });

  it("an event with no later edits reverts exactly", async () => {
    const id = await note("d79 plain", "alpha\nbeta\n");
    const a = await edit(id, "alpha\nbeta gamma\n");
    expect(await preview(a)).toMatchObject({ can_apply_cleanly: true, restored_body: "alpha\nbeta\n" });
    expect((await restore(a)).status).toBe(200);
    expect(await body(id)).toBe("alpha\nbeta\n");
  });
});
