// D88: a drawing save that names its base merges into what another device
// stored meanwhile (services/attributeWrites.ts MERGED_KEYS, @onden/markdown/ink
// mergeInk) instead of overwriting it. Only an item both sides changed is an
// ATTRIBUTE_CONFLICT. A save without a base keeps last-writer-wins.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
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
const S1 = stroke("s1"), S2 = stroke("s2"), S3 = stroke("s3");

async function newNote(ink: string): Promise<string> {
  const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `ink merge ${Date.now()}`, markdown: "x" } })).json()) as { id: string }).id;
  await saveInk(id, ink);
  return id;
}
async function saveInk(nodeId: string, value: string, base?: string): Promise<{ value: string; conflict?: { ink_conflicts?: unknown[] } }> {
  const res = await req(`/api/nodes/${nodeId}/attributes/ink_data`, {
    method: "PUT", json: { value, value_type: "text", is_inheritable: false, ...(base !== undefined ? { base_value: base } : {}) },
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ value: string; conflict?: { ink_conflicts?: unknown[] } }>;
}
async function stored(nodeId: string): Promise<{ strokes: Stroke[]; erased: Record<string, number[][]> }> {
  const row = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [nodeId])).rows[0]!;
  return JSON.parse(row.value);
}
async function conflicts(nodeId: string): Promise<Array<Record<string, unknown>>> {
  return (await q<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT' ORDER BY id`, [nodeId])).rows.map((r) => r.payload);
}

describe.skipIf(!isTestDb)("ink_data saves merge with their base (D88)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
  });

  it("the repro: laptop saves {S1,S2}, the offline tablet's {S1,S3} replays → {S1,S2,S3}, no conflict", async () => {
    const id = await newNote(page([S1]));
    await saveInk(id, page([S1, S2]), page([S1]));          // laptop
    const result = await saveInk(id, page([S1, S3]), page([S1])); // tablet, replayed from its queue
    expect((await stored(id)).strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
    expect(JSON.parse(result.value).strokes).toHaveLength(3); // the response carries the merge
    expect(result.conflict).toBeUndefined();
    expect(await conflicts(id)).toEqual([]);
  });

  it("an erase on one device and a stroke on the other are both applied", async () => {
    const id = await newNote(page([S1]));
    await saveInk(id, page([S1], { s1: [[0, 1]] }), page([S1]));
    await saveInk(id, page([S1, S2]), page([S1]));
    const doc = await stored(id);
    expect(doc.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(doc.erased).toEqual({ s1: [[0, 1]] });
    expect(await conflicts(id)).toEqual([]);
  });

  it("the same stroke changed on both devices: one version kept (a fixed order of the two values, not who saved last), ATTRIBUTE_CONFLICT recorded with both", async () => {
    const id = await newNote(page([S1]));
    await saveInk(id, page([stroke("s1", "#f00")]), page([S1]));
    const result = await saveInk(id, page([stroke("s1", "#00f"), S2]), page([S1]));
    const doc = await stored(id);
    expect(doc.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(["#f00", "#00f"]).toContain(doc.strokes[0]!.color);
    expect(result.conflict?.ink_conflicts).toEqual([{ kind: "stroke", id: "s1" }]);
    const [record, ...more] = await conflicts(id);
    expect(more).toEqual([]);
    // The two drawings are blob references (D90: attributeConflictRevert.integration.test.ts).
    expect(record).toMatchObject({
      key: "ink_data", overridden_value_len: page([stroke("s1", "#f00")]).length, incoming_value_len: result.value.length,
      submitted_value_len: page([stroke("s1", "#00f"), S2]).length,
      ink_conflicts: [{ kind: "stroke", id: "s1" }],
    });
  });

  it("a save whose base is what is stored is stored exactly as sent", async () => {
    const id = await newNote(page([S1]));
    const next = page([S1, S2]);
    expect((await saveInk(id, next, page([S1]))).value).toBe(next);
  });

  it("without a base, the last write still wins (older clients)", async () => {
    const id = await newNote(page([S1]));
    await saveInk(id, page([S1, S2]), page([S1]));
    await saveInk(id, page([S1, S3]));
    expect((await stored(id)).strokes.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("a base on another key is ignored (only drawings merge)", async () => {
    const id = await newNote(page([]));
    const put = (value: string) => req(`/api/nodes/${id}/attributes/status`, { method: "PUT", json: { value, base_value: "draft" } });
    expect((await put("draft")).status).toBe(200);
    expect(((await (await put("done")).json()) as { value: string }).value).toBe("done");
  });
});

// The whiteboard's pen layer is the note's own attribute, board_ink: the same page format
// and the same merging write as ink_data, and no effect on the note's handwriting page.
describe.skipIf(!isTestDb)("board_ink saves merge like ink_data and stay apart from it", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id;
  });
  const board = (nodeId: string, value: string, base?: string) =>
    req(`/api/nodes/${nodeId}/attributes/board_ink`, { method: "PUT", json: { value, value_type: "text", is_inheritable: false, ...(base !== undefined ? { base_value: base } : {}) } });
  const boardValue = async (nodeId: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'board_ink'`, [nodeId])).rows[0]?.value;

  it("two devices' strokes on the same board merge; a stroke change on both is a recorded conflict", async () => {
    const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `board ink ${Date.now()}`, markdown: "text" } })).json()) as { id: string }).id;
    expect((await board(id, page([S1]))).status).toBe(200);
    await board(id, page([S1, S2]), page([S1]));
    expect((await board(id, page([S1, S3]), page([S1]))).status).toBe(200);
    expect((JSON.parse((await boardValue(id))!) as { strokes: Stroke[] }).strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);

    await board(id, page([stroke("s1", "#f00"), S2, S3]), page([S1, S2, S3]));
    await board(id, page([stroke("s1", "#00f"), S2, S3]), page([S1, S2, S3]));
    const [record] = await conflicts(id);
    expect(record).toMatchObject({ key: "board_ink", ink_conflicts: [{ kind: "stroke", id: "s1" }] });
    // A conflict list carries blob references, not the two drawings.
    expect(record).not.toHaveProperty("incoming_value");
  });

  it("the board's strokes are not the note's handwriting page: ink_data is not written, and the note has none", async () => {
    const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `board only ${Date.now()}`, markdown: "text" } })).json()) as { id: string }).id;
    await board(id, page([S1]));
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [id])).rows).toHaveLength(0);
    // Saving the handwriting page afterwards leaves the board layer as it was.
    await saveInk(id, page([S2]));
    expect(JSON.parse((await boardValue(id))!).strokes.map((s: Stroke) => s.id)).toEqual(["s1"]);
    expect((await stored(id)).strokes.map((s) => s.id)).toEqual(["s2"]);
    // Its saves are stored content-addressed (a blob reference in the event), as a drawing's are.
    const event = (await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'board_ink'`, [id])).rows[0]!.payload;
    expect(event).toHaveProperty("value_ref");
  });
});

