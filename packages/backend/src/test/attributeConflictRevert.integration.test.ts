// D90: an ATTRIBUTE_CONFLICT is recorded and reverted by the type of what it
// holds. A drawing's two values are blob references (never inline MBs the
// inbox poll downloads); its revert takes back only the strokes both devices
// changed and keeps every other stroke. Any other key reverts to its
// overridden value with the type it had (services/attributeWrites.ts
// revertAttributeConflict, POST /api/events/:id/revert-conflict).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

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

let defaultSpaceId = "";

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

type Stroke = { id: string; points: number[][]; color: string; size: number; toolId: string };
const stroke = (id: string, color = "#000"): Stroke => ({ id, points: [[0, 0], [5, 5], [10, 10], [15, 15]], color, size: 2, toolId: "pen" });
const page = (strokes: Stroke[], erased: Record<string, number[][]> = {}) =>
  JSON.stringify({ version: 1, strokes, erased, page: { width: 1000 } });
const S1 = stroke("s1"), S2 = stroke("s2"), S3 = stroke("s3"), S4 = stroke("s4");
const LONG_AGO = "2000-01-01T00:00:00.000Z"; // a client edit made before the stored value

async function newNote(): Promise<string> {
  const res = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `conflict ${Date.now()}`, markdown: "x" } });
  return ((await res.json()) as { id: string }).id;
}
async function put(nodeId: string, key: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // As the app sends it: the device's own clock reading at the moment of sending (frontend lib/api.ts).
  const res = await req(`/api/nodes/${nodeId}/attributes/${key}`, { method: "PUT", json: body, headers: { "X-Onden-Client-Now": String(Date.now()) } });
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}
async function conflicts(nodeId: string): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  return (await q<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id::text, payload FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT' ORDER BY domain_events.id`, [nodeId])).rows;
}
async function stored(nodeId: string, key: string): Promise<{ value: string; value_type: string; is_inheritable: boolean }> {
  return (await q<{ value: string; value_type: string; is_inheritable: boolean }>(
    `SELECT value, value_type, is_inheritable FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0]!;
}
const revert = (eventId: string, headers: Record<string, string> = {}) =>
  req(`/api/events/${eventId}/revert-conflict`, { method: "POST", headers });
const strokesOf = (raw: string) => (JSON.parse(raw) as { strokes: Stroke[] }).strokes.map((s) => [s.id, s.color]);

describe.skipIf(!isTestDb)("attribute conflicts: recorded and reverted by type (D90)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
  });

  /** Laptop recolours s1 red and draws S2; the tablet, from the same base,
   *  recolours s1 blue and draws S3. The merge keeps blue s1 (a conflict). */
  async function inkConflict(): Promise<{ nodeId: string; eventId: string; merged: string; overridden: string }> {
    const nodeId = await newNote();
    await put(nodeId, "ink_data", { value: page([S1]), base_value: "" });
    const overridden = page([stroke("s1", "#f00"), S2]);
    await put(nodeId, "ink_data", { value: overridden, base_value: page([S1]) });
    const merged = (await put(nodeId, "ink_data", { value: page([stroke("s1", "#00f"), S3]), base_value: page([S1]) })).value as string;
    const [record] = await conflicts(nodeId);
    return { nodeId, eventId: record!.id, merged, overridden };
  }

  it("an ink conflict stores blob references, not the drawings inline", async () => {
    const { nodeId, merged, overridden } = await inkConflict();
    const [record, ...more] = await conflicts(nodeId);
    expect(more).toEqual([]);
    const p = record!.payload;
    expect(p).not.toHaveProperty("incoming_value");
    expect(p).not.toHaveProperty("overridden_value");
    expect(p).toMatchObject({
      key: "ink_data", value_type: "text", overridden_value_type: "text",
      incoming_value_len: merged.length, overridden_value_len: overridden.length,
      ink_conflicts: [{ kind: "stroke", id: "s1" }],
    });
    const blob = (hash: unknown) => q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [hash]).then((r) => r.rows[0]?.content);
    expect(await blob(p.incoming_value_ref)).toBe(merged);
    expect(await blob(p.overridden_value_ref)).toBe(overridden);
    // The inbox's poll carries the summary only.
    const listed = (await (await req(`/api/events?event_type=ATTRIBUTE_CONFLICT&target_id=${nodeId}&limit=50`)).json()) as { events: Array<{ payload: Record<string, unknown> }> };
    expect(JSON.stringify(listed.events[0]!.payload)).not.toContain("strokes");
  });

  it("revert takes back the conflicting stroke and keeps both devices' other strokes, and one drawn since", async () => {
    const { nodeId, eventId, merged } = await inkConflict();
    expect(strokesOf(merged)).toEqual([["s1", "#00f"], ["s3", "#000"], ["s2", "#000"]]);
    // Another device draws S4 after the merge.
    await put(nodeId, "ink_data", { value: page([stroke("s1", "#00f"), S3, S2, S4]), base_value: merged });
    const res = await revert(eventId);
    expect(res.status).toBe(200);
    const doc = await stored(nodeId, "ink_data");
    expect(strokesOf(doc.value)).toEqual([["s1", "#f00"], ["s3", "#000"], ["s2", "#000"], ["s4", "#000"]]);
    expect(((await res.json()) as { value: string }).value).toBe(doc.value);
    // A plain new write, not another conflict.
    expect(await conflicts(nodeId)).toHaveLength(1);
  });

  it("a numeric attribute reverts as a number, once per request key, and not over a later edit", async () => {
    const nodeId = await newNote();
    await put(nodeId, "score", { value: 5, value_type: "number" });
    await put(nodeId, "score", { value: 7, value_type: "number", client_updated_at: LONG_AGO });
    const [record] = await conflicts(nodeId);
    expect(record!.payload).toMatchObject({ key: "score", incoming_value: "7", overridden_value: "5", value_type: "number", overridden_value_type: "number" });

    const key = { "Idempotency-Key": randomUUID() };
    expect((await revert(record!.id, key)).status).toBe(200);
    expect(await stored(nodeId, "score")).toMatchObject({ value: "5", value_type: "number" });
    // A lost response retried with the same key: a replay, not a refusal.
    const retry = await revert(record!.id, key);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deduped: true });

    // Changed since the conflict: the later edit is kept.
    await put(nodeId, "score", { value: 9, value_type: "number", client_updated_at: LONG_AGO });
    const [, second] = await conflicts(nodeId);
    await put(nodeId, "score", { value: 11, value_type: "number" });
    const refused = await revert(second!.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("attribute_changed");
    expect((await stored(nodeId, "score")).value).toBe("11");
  });

  it("an inheritable attribute stays inheritable", async () => {
    const nodeId = await newNote();
    await put(nodeId, "status", { value: "draft", is_inheritable: true });
    await put(nodeId, "status", { value: "done", is_inheritable: true, client_updated_at: LONG_AGO });
    const [record] = await conflicts(nodeId);
    expect((await revert(record!.id)).status).toBe(200);
    expect(await stored(nodeId, "status")).toMatchObject({ value: "draft", value_type: "text", is_inheritable: true });
  });

  describe("a device with a wrong clock", () => {
    const HOUR = 3_600_000;
    // The device's own clock reading at sending, and the time it dated the edit with: the age is their difference.
    const putFrom = async (nodeId: string, value: string, clockOffsetMs: number, editMadeMsBeforeSending: number) => {
      const sentAt = Date.now() + clockOffsetMs;
      const res = await req(`/api/nodes/${nodeId}/attributes/status`, {
        method: "PUT", headers: { "X-Onden-Client-Now": String(sentAt) },
        json: { value, value_type: "text", client_updated_at: new Date(sentAt - editMadeMsBeforeSending).toISOString() },
      });
      expect(res.status).toBe(200);
    };

    it("hours behind: a fresh edit is not recorded as a conflict because its clock reads older than the stored value", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      await putFrom(nodeId, "fresh-from-slow-clock", -3 * HOUR, 0);
      expect(await conflicts(nodeId)).toHaveLength(0);
      expect((await stored(nodeId, "status")).value).toBe("fresh-from-slow-clock");
    });

    it("hours ahead: an edit made an hour before it was sent is still recorded as a conflict although its clock reads newer", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      await putFrom(nodeId, "old-from-fast-clock", 3 * HOUR, HOUR);
      const [record] = await conflicts(nodeId);
      expect(record!.payload).toMatchObject({ key: "status", incoming_value: "old-from-fast-clock", overridden_value: "stored" });
      // last write still wins: the value stays where it landed
      expect((await stored(nodeId, "status")).value).toBe("old-from-fast-clock");
    });

    it("hours ahead and hours behind, edits made just now: neither is flagged", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      await putFrom(nodeId, "ahead-now", 3 * HOUR, 0);
      await putFrom(nodeId, "behind-now", -3 * HOUR, 0);
      expect(await conflicts(nodeId)).toHaveLength(0);
    });

    it("an older client without the clock reading is never flagged by its own clock", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      const res = await req(`/api/nodes/${nodeId}/attributes/status`, { method: "PUT", json: { value: "no-reading", value_type: "text", client_updated_at: LONG_AGO } });
      expect(res.status).toBe(200);
      expect(await conflicts(nodeId)).toHaveLength(0);
    });
  });

  describe("a logical clock that was pushed into the future (stamps received from another node)", () => {
    const DAY = 86_400_000;
    let clockBefore: { hlc_wall: string; hlc_counter: number } | undefined;
    const workspace = async () => await getWorkspaceId();
    beforeAll(async () => {
      const ws = await workspace();
      await q(`INSERT INTO sync_clock (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`, [ws]);
      clockBefore = (await q<{ hlc_wall: string; hlc_counter: number }>(`SELECT hlc_wall::text, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0];
      await q(`UPDATE sync_clock SET hlc_wall = $2, hlc_counter = 0 WHERE workspace_id = $1`, [ws, Date.now() + DAY]);
    });
    afterAll(async () => {
      if (clockBefore) await q(`UPDATE sync_clock SET hlc_wall = GREATEST(hlc_wall - $2, $3::bigint) WHERE workspace_id = $1`, [await workspace(), DAY, clockBefore.hlc_wall]);
    });
    const putOld = async (nodeId: string, value: string, editMadeMsBeforeSending: number) => {
      const sentAt = Date.now();
      await put(nodeId, "status", { value, value_type: "text", client_updated_at: new Date(sentAt - editMadeMsBeforeSending).toISOString() });
    };

    it("an edit made an hour before the stored value was written is still recorded as a conflict", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      await putOld(nodeId, "made-an-hour-ago", 3_600_000);
      const [record] = await conflicts(nodeId);
      expect(record!.payload).toMatchObject({ key: "status", incoming_value: "made-an-hour-ago", overridden_value: "stored" });
    });

    it("an edit made just now is not flagged", async () => {
      const nodeId = await newNote();
      await put(nodeId, "status", { value: "stored" });
      await putOld(nodeId, "just-now", 0);
      expect(await conflicts(nodeId)).toHaveLength(0);
    });
  });

  it("a value changed after its stamp by a writer that leaves no stamp still counts as the stored side's time", async () => {
    const nodeId = await newNote();
    await put(nodeId, "status", { value: "from-the-screen" }); // stamped at T1
    await new Promise((r) => setTimeout(r, 1000));
    // the text-produced value replaces it at T2 (T1 + 1 s): updated_at moves, no stamp is made
    await seedQ(`UPDATE node_attributes SET value = 'from-the-body', source = 'markdown', updated_at = now() WHERE node_id = $1 AND key = 'status'`, [nodeId]);
    await new Promise((r) => setTimeout(r, 300));
    // another device edited the old screen value 700 ms before T2 (between T1 and T2) and sends it now
    await put(nodeId, "status", { value: "from-the-old-screen", client_updated_at: new Date(Date.now() - 1000).toISOString() });
    const [record] = await conflicts(nodeId);
    expect(record!.payload).toMatchObject({ key: "status", incoming_value: "from-the-old-screen", overridden_value: "from-the-body" });
  });

  it("an event that is not an attribute conflict is not found", async () => {
    const nodeId = await newNote();
    const created = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 ORDER BY domain_events.id LIMIT 1`, [nodeId])).rows[0]!;
    expect((await revert(created.id)).status).toBe(404);
    expect((await revert("999999999")).status).toBe(404);
  });
});
