// ⑤ ink hash-pointer: ink_data events carry value_ref (events→hash→blobs,
// same model as markdown bodies) instead of embedding the full drawing JSON
// into the append-only log twice per save. The LIVE node_attributes row keeps
// the full value (no read-path change); restore/preview resolve the hash.
// Also pins the inverse fix: overwriting ANY attribute now inverts to
// attribute.set with the prior value — undo used to DELETE the attribute.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";

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

// Top-level notes created as the System actor must name their space (it has
// no personal space and may be in several shared ones).
let defaultSpaceId = "";

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

const inkDoc = (n: number) => JSON.stringify({
  version: 1,
  strokes: Array.from({ length: 40 }, (_, i) => ({ id: `s${n}-${i}`, points: [[i, i], [i + 1, i + 2]], color: "#000" })),
  rev: n,
});

describe.skipIf(!isTestDb)("ink hash-pointer (⑤)", () => {
  let nodeId = "";
  const v1 = inkDoc(1), v2 = inkDoc(2);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
  });

  // Each test gets its own drawing note saved twice (v1 then v2), so none
  // depends on what another test appended to the log or left live.
  beforeEach(async () => {
    nodeId = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `ink ${Date.now()}`, markdown: "x" } })).json()) as { id: string }).id;
    expect((await req(`/api/nodes/${nodeId}/attributes/ink_data`, { method: "PUT", json: { value: v1, value_type: "text", is_inheritable: false } })).status).toBeLessThan(300);
    expect((await req(`/api/nodes/${nodeId}/attributes/ink_data`, { method: "PUT", json: { value: v2, value_type: "text", is_inheritable: false } })).status).toBeLessThan(300);
  });

  // A fresh note, so the version list is exactly [v2, v1]. This is the data the ink-diff viewer
  // consumes (lib/ink/diff.ts) — the gap was that /:id/versions filters on
  // body_hash and never surfaced these.
  it("ink-versions lists each handwriting save newest-first with resolvable strokes", async () => {
    const versions = (await (await req(`/api/nodes/${nodeId}/ink-versions`)).json()) as Array<{ id: string; ink_data: string; changed_at: string }>;
    expect(versions.length).toBe(2);
    expect(versions[0]!.ink_data).toBe(v2);                            // newest first
    expect(versions[1]!.ink_data).toBe(v1);
    expect(JSON.parse(versions[0]!.ink_data).strokes.length).toBe(40); // parses as an InkDocument
  });

  it("events carry value_ref, never the drawing JSON; the live row keeps the full value", async () => {
    const evs = await q<{ id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
      `SELECT id::text, payload, tx_meta FROM domain_events
        WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'ink_data'
        ORDER BY domain_events.id ASC`, [nodeId]);
    expect(evs.rows.length).toBe(2);
    for (const ev of evs.rows) {
      expect(ev.payload.value).toBeUndefined();                       // no JSON in the log
      expect(typeof ev.payload.value_ref).toBe("string");
      expect(Number(ev.payload.value_len)).toBeGreaterThan(100);
    }
    // second save's inverse points at the FIRST blob (attribute.set, not delete)
    const second = evs.rows[1]!;
    expect(second.tx_meta.inverse_op).toBe("attribute.set");
    const prevRef = (second.tx_meta.prev_field_values as { value_ref?: string }).value_ref!;
    const blob = await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [prevRef]);
    expect(blob.rows[0]!.content).toBe(v1);
    // live row = full current JSON (read paths unchanged)
    const live = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [nodeId]);
    expect(live.rows[0]!.value).toBe(v2);
  });

  it("preview + restore of an ink save resolve the hash: undo returns to v1, not deletion", async () => {
    const ev = await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET'
        AND payload->>'key' = 'ink_data' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId]);
    const id = ev.rows[0]!.id;
    const prev = (await (await req(`/api/events/${id}/preview`)).json()) as { preview: { restored_value: string | null; action: string } };
    expect(prev.preview.action).toBe("set");
    expect(prev.preview.restored_value).toBe(v1);

    expect((await req(`/api/events/${id}/restore`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const live = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [nodeId]);
    expect(live.rows[0]!.value).toBe(v1);                             // back ONE save — the drawing survives
    // and the restore event itself is hash-pointed (no JSON re-embedded)
    const rev = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET'
        AND payload->>'key' = 'ink_data' ORDER BY id DESC LIMIT 1`, [nodeId]);
    expect(rev.rows[0]!.payload.value).toBeUndefined();
    expect(typeof rev.rows[0]!.payload.value_ref).toBe("string");
  });

  it("DELETE ink_data captures a hash pointer; restore brings the drawing back", async () => {
    expect((await req(`/api/nodes/${nodeId}/attributes/ink_data`, { method: "DELETE" })).status).toBeLessThan(300);
    const del = await q<{ id: string; tx_meta: Record<string, unknown> }>(
      `SELECT id::text, tx_meta FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_DELETED'
        AND payload->>'key' = 'ink_data' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId]);
    const pf = del.rows[0]!.tx_meta.prev_field_values as { value?: string; value_ref?: string };
    expect(pf.value).toBeUndefined();
    expect(typeof pf.value_ref).toBe("string");

    expect((await req(`/api/events/${del.rows[0]!.id}/restore`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const live = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [nodeId]);
    expect(live.rows[0]!.value).toBe(v2); // the value that was live at delete time
  });

  it("plain attributes: undoing an overwrite restores the prior value (was: deleted)", async () => {
    await req(`/api/nodes/${nodeId}/attributes/color`, { method: "PUT", json: { value: "red", value_type: "text", is_inheritable: false } });
    await req(`/api/nodes/${nodeId}/attributes/color`, { method: "PUT", json: { value: "blue", value_type: "text", is_inheritable: false } });
    const ev = await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET'
        AND payload->>'key' = 'color' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId]);
    expect((await req(`/api/events/${ev.rows[0]!.id}/restore`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const live = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'color'`, [nodeId]);
    expect(live.rows[0]!.value).toBe("red");
  });
});
