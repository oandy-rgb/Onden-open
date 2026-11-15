// A PDF note's drawing is saved again for every stroke. What a save sends is the patch (frontend test
// pdfInkSaveBudget), and what it STORES is only what changed: a value over INK_CHUNK_THRESHOLD is kept as chunks of the
// note (services/inkChunks.ts, migration 203) instead of one full copy per save in `blobs`. History, "restore this
// version", undo, the day feed and the patch bases still read every version whole.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { makePatch } from "@onden/markdown";
import { q, getWorkspaceId } from "../db.js";
import { INK_CHUNK_THRESHOLD, readInkValue } from "../services/inkChunks.js";
import { putBlob } from "../services/blobs.js";
import { collectOrphanBlobs } from "../services/maintenance/prune.js";
import { readFileSync } from "node:fs";
import { sha256Hex } from "../utils.js";
import { pdfInkSim } from "./helpers/pdfInkEnvelope.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response("noop", { status: 200 })), api: { getSession: vi.fn(async () => null) }, $context: Promise.resolve({ runMigrations: async () => {} }) },
}));
const { app } = await import("../app.js");

const JSON_HEADERS = { origin: "http://localhost", "content-type": "application/json" };
const call = (method: string, path: string, json?: unknown) =>
  Promise.resolve(app.request(path, { method, headers: JSON_HEADERS, body: json === undefined ? undefined : JSON.stringify(json) }));

let spaceId = "";
let workspaceId = "";
async function newNote(): Promise<string> {
  const res = await call("POST", "/api/nodes", { space_id: spaceId, title: `pdf ink ${Math.random()}`, markdown: "x" });
  return ((await res.json()) as { id: string }).id;
}
/** Save `next` the way the app does: the first as a whole value, then as a patch against the previous save. */
async function save(nodeId: string, previous: string | null, next: string): Promise<void> {
  const body = previous === null
    ? { value: next, value_type: "text", is_inheritable: false }
    : { value_patch: makePatch(previous, next), value_type: "text", is_inheritable: false };
  const res = await call("PUT", `/api/nodes/${nodeId}/attributes/ink_data`, body);
  expect(res.status, await res.clone().text()).toBe(200);
}
/** The save's event ids, oldest first. */
const saveEvents = async (nodeId: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload->>'key' = 'ink_data' AND event_type = 'ATTRIBUTE_SET' ORDER BY domain_events.id`, [nodeId])).rows.map((r) => r.id);
const storedValue = async (nodeId: string) =>
  (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [nodeId])).rows[0]!.value;

/** Bytes of drawing text kept anywhere for history (whole copies in `blobs`, chunks, manifests), as the text itself. */
async function storedDrawingBytes(nodeId: string): Promise<number> {
  const events = (await q<{ ref: string }>(
    `SELECT DISTINCT r.ref FROM domain_events e, unnest(ARRAY[e.payload->>'value_ref', e.tx_meta->'prev_field_values'->>'value_ref']) AS r(ref)
      WHERE e.target_id = $1 AND r.ref IS NOT NULL`, [nodeId])).rows.map((r) => r.ref);
  const whole = Number((await q<{ n: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM blobs WHERE hash = ANY($1::text[])`, [events])).rows[0]!.n);
  const tables = (await q<{ t: string | null }>(`SELECT to_regclass('ink_chunks')::text AS t`)).rows[0]!.t;
  if (!tables) return whole;
  const chunks = Number((await q<{ n: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM ink_chunks WHERE node_id = $1`, [nodeId])).rows[0]!.n);
  const manifests = Number((await q<{ n: string }>(`SELECT COALESCE(sum(octet_length(chunks)), 0)::text AS n FROM ink_manifests WHERE node_id = $1`, [nodeId])).rows[0]!.n);
  return whole + chunks + manifests;
}

/** Grow a PDF drawing past the chunk threshold, saving each stroke; returns every saved value. */
async function drawUntilBig(nodeId: string, extraStrokes = 0): Promise<{ values: string[]; sim: ReturnType<typeof pdfInkSim> }> {
  const sim = pdfInkSim({ seed: 11 });
  const values: string[] = [];
  let previous: string | null = null;
  let past = 0;
  for (let i = 0; past <= extraStrokes && i < 2000; i++) {
    const next = sim.drawStroke();
    await save(nodeId, previous, next);
    values.push(next); previous = next;
    if (next.length >= INK_CHUNK_THRESHOLD) past++;
  }
  return { values, sim };
}

describe.skipIf(!isTestDb)("a big PDF drawing is stored as chunks, and every saved version still reads whole", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    workspaceId = await getWorkspaceId();
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  }, 120_000);

  it("keeps a manifest per big save and no whole copy of it in blobs", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 3);
    const big = values.filter((v) => v.length >= INK_CHUNK_THRESHOLD);
    expect(big.length).toBeGreaterThanOrEqual(4);
    const manifests = (await q<{ hash: string }>(`SELECT hash FROM ink_manifests WHERE node_id = $1`, [id])).rows.map((r) => r.hash);
    expect(new Set(manifests)).toEqual(new Set(big.map(sha256Hex)));
    const whole = (await q(`SELECT 1 FROM blobs WHERE hash = ANY($1::text[])`, [big.map(sha256Hex)])).rows;
    expect(whole).toEqual([]);
    for (const v of [big[0]!, big[big.length - 1]!]) expect(await readInkValue(workspaceId, id, sha256Hex(v))).toBe(v);
  }, 120_000);

  it("History lists every version whole (ink-versions), small and chunked alike", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 2);
    const res = await call("GET", `/api/nodes/${id}/ink-versions`);
    const rows = (await res.json()) as Array<{ id: string; ink_data: string }>;
    const newestFirst = rows.map((r) => r.ink_data);
    expect(newestFirst).toEqual(values.slice(-newestFirst.length).reverse());
  }, 120_000);

  it("restores an older chunked version as a new write, and undoes a save", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 4);
    const events = await saveEvents(id);
    const target = values.length - 4; // a big version, not the latest
    const restore = await call("POST", `/api/nodes/${id}/ink-versions/${events[target]}/restore`);
    expect(restore.status, await restore.clone().text()).toBe(200);
    expect(await storedValue(id)).toBe(values[target]);
    // The restore is itself a save: History keeps counting it, and its value reads back.
    const after = await saveEvents(id);
    expect(after.length).toBe(events.length + 1);

    // Undo (restoreEvent) of that restore brings the latest drawing back.
    const undo = await call("POST", `/api/events/${after[after.length - 1]}/restore`, {});
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(await storedValue(id)).toBe(values[values.length - 1]);
  }, 180_000);

  it("a patch whose base is an older chunked version of the note applies; another note's is refused", async () => {
    const id = await newNote();
    const { values, sim } = await drawUntilBig(id, 2);
    const older = values[values.length - 2]!;
    const next = sim.drawStroke();
    const res = await call("PUT", `/api/nodes/${id}/attributes/ink_data`, { value_patch: makePatch(older, next), value_type: "text", is_inheritable: false });
    expect(res.status, await res.clone().text()).toBe(200);
    const other = await newNote();
    const refused = await call("PUT", `/api/nodes/${other}/attributes/ink_data`, { value_patch: makePatch(older, next), value_type: "text", is_inheritable: false });
    expect(refused.status).toBe(409);
  }, 120_000);

  it("a value stored whole (before chunks existed) is read as before", async () => {
    const id = await newNote();
    const text = pdfInkSim({ seed: 3 }).value() + "x".repeat(INK_CHUNK_THRESHOLD + 10);
    const hash = await putBlob(text);
    expect(await readInkValue(workspaceId, id, hash)).toBe(text);
    expect(await readInkValue(workspaceId, id, sha256Hex("never stored"))).toBeNull();
  });

  it("a save adds a small part of what it saved: the storage budget", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 0);
    const sim = pdfInkSim({ seed: 11 });
    values.forEach(() => sim.drawStroke());
    let previous = values[values.length - 1]!;
    const before = await storedDrawingBytes(id);
    const SAVES = 40;
    for (let i = 0; i < SAVES; i++) { const next = sim.drawStroke(); await save(id, previous, next); previous = next; }
    const perSave = (await storedDrawingBytes(id) - before) / SAVES;
    // A whole copy per save would be previous.length (>= 190 KB here, MBs on a real PDF). Chunks of the strokes' places plus the
    // manifest stay under a fifth of it; measured ~25 KB at this size (docs/research/pdf-ink-save-measure-2026-11-15.md).
    expect(perSave).toBeLessThan(previous.length / 5);
    expect(perSave).toBeLessThan(80_000);
  }, 240_000);

  it("the clean-up takes a chunk-stored drawing whose events are gone and keeps one an event names", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 1);
    const last = values[values.length - 1]!;
    // An orphan: a manifest and chunks no event names, older than the grace.
    const { putInkChunks } = await import("../services/inkChunks.js");
    const orphan = last + " ".repeat(100) + "{},{},{},";
    const orphanHash = await putInkChunks(workspaceId, id, orphan);
    await q(`UPDATE ink_manifests SET created_at = now() - interval '3 days' WHERE node_id = $1 AND hash = $2`, [id, orphanHash]);
    await q(`UPDATE ink_chunks SET created_at = now() - interval '3 days' WHERE node_id = $1`, [id]);
    const report = await collectOrphanBlobs();
    expect(report.inkManifests).toBeGreaterThanOrEqual(1);
    expect(await readInkValue(workspaceId, id, orphanHash)).toBeNull();
    expect(await readInkValue(workspaceId, id, sha256Hex(last))).toBe(last);
    expect(await storedValue(id)).toBe(last);
  }, 120_000);

  it("deleting the note for good takes its chunks with it", async () => {
    const id = await newNote();
    await drawUntilBig(id, 1);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_chunks WHERE node_id = $1`, [id])).rows[0]!.n)).toBeGreaterThan(0);
    expect((await call("DELETE", `/api/nodes/${id}`)).status).toBe(200);
    const purge = await call("POST", `/api/nodes/${id}/purge`, { expected_ids: [id] });
    expect(purge.status, await purge.clone().text()).toBe(200);
    for (const t of ["ink_chunks", "ink_manifests"]) {
      expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE node_id = $1`, [id])).rows[0]!.n), t).toBe(0);
    }
  }, 120_000);

  // The restore drill (scripts/drillInvariants.ts) counts a drawing version an event names but nothing can read any more.
  it("the drill's unreadable-version check is empty for a healthy note and names one whose chunk is gone", async () => {
    const script = readFileSync(new URL("../../scripts/drillInvariants.ts", import.meta.url), "utf8");
    const check = /name: "ink_version_unreadable"[\s\S]*?sql: `([\s\S]*?)` \}/.exec(script)![1]!;
    const id = await newNote();
    await drawUntilBig(id, 1);
    const unreadable = async () => (await q<{ id: string }>(check)).rows.length;
    expect(await unreadable()).toBe(0);
    await q(`DELETE FROM ink_chunks WHERE node_id = $1 AND hash = (SELECT hash FROM ink_chunks WHERE node_id = $1 LIMIT 1)`, [id]);
    expect(await unreadable()).toBeGreaterThan(0);
  }, 120_000);

  it("the clean-up leaves every version a note's history still names readable (a note saved many times, then the sweep)", async () => {
    const id = await newNote();
    const { values } = await drawUntilBig(id, 6);
    // Everything of this note is past the grace, so only the references decide.
    await q(`UPDATE ink_manifests SET created_at = now() - interval '3 days' WHERE node_id = $1`, [id]);
    await q(`UPDATE ink_chunks SET created_at = now() - interval '3 days' WHERE node_id = $1`, [id]);
    const before = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_chunks WHERE node_id = $1`, [id])).rows[0]!.n);
    await collectOrphanBlobs();
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_chunks WHERE node_id = $1`, [id])).rows[0]!.n)).toBe(before);
    for (const value of values) expect(await readInkValue(workspaceId, id, sha256Hex(value))).toBe(value);
    const versions = ((await (await call("GET", `/api/nodes/${id}/ink-versions`)).json()) as Array<{ ink_data: string }>).map((r) => r.ink_data);
    expect(versions).toEqual(values.slice(-versions.length).reverse());
  }, 180_000);
});
