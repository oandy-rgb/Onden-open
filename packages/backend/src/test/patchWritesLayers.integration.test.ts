// A drawing (`ink_data`) and a page's text boxes (`page_text`) saved as a patch
// against the value they were made from (`value_patch`,
// docs/architecture/patch-writes.md): the same merge as `value` + `base_value`,
// a few hundred bytes on the wire instead of the whole drawing twice.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { makePatch } from "@onden/markdown";
import { encodePageText, type PageTextBox } from "@onden/markdown/page-text";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

let spaceId = "";
const req = (path: string, method: string, json?: unknown) => Promise.resolve(app.request(path, {
  method, headers: { origin: "http://localhost", ...(json === undefined ? {} : { "content-type": "application/json" }) },
  body: json === undefined ? undefined : JSON.stringify(json),
}));

type Stroke = { id: string; points: number[][]; color: string; size: number; toolId: string };
const stroke = (id: string): Stroke => ({
  id, color: "#000", size: 2, toolId: "pen",
  points: Array.from({ length: 40 }, (_, i) => [i * 3.25, i * 1.5 + 7, 0.5]),
});
const page = (strokes: Stroke[]) => JSON.stringify({ version: 1, strokes, erased: {}, page: { width: 1000 } });
const strokes = (from: number, count: number) => Array.from({ length: count }, (_, i) => stroke(`s${from + i}`));

const newNote = async () => ((await (await req("/api/nodes", "POST", { space_id: spaceId, title: `layer patch ${randomUUID()}`, markdown: "x" })).json()) as { id: string }).id;
const put = (id: string, key: string, body: unknown) => req(`/api/nodes/${id}/attributes/${key}`, "PUT", { value_type: "text", is_inheritable: false, ...(body as object) });
const whole = (id: string, key: string, value: string, base?: string) => put(id, key, { value, ...(base !== undefined ? { base_value: base } : {}) });
const patch = (id: string, key: string, base: string, next: string) => put(id, key, { value_patch: makePatch(base, next) });
const stored = async (id: string, key: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value ?? null;
const ids = (raw: string | null) => (JSON.parse(raw!) as { strokes: Stroke[] }).strokes.map((s) => s.id);

describe.skipIf(!isTestDb)("drawings and page layers saved as a patch", () => {
  // The big drawings leave tens of MB of events and blobs in the shared test
  // database, which slows other files' purge and media tests: take them away.
  const bigNotes: string[] = [];
  afterAll(async () => {
    if (bigNotes.length === 0) return;
    const hashes = (await q<{ hash: string | null }>(
      `SELECT DISTINCT h AS hash FROM domain_events e, unnest(ARRAY[e.payload->>'value_ref', e.tx_meta->'prev_field_values'->>'value_ref']) h
        WHERE e.target_id = ANY($1::text[]) AND h IS NOT NULL`, [bigNotes])).rows.map((r) => r.hash!);
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [bigNotes]);
    await q(`DELETE FROM blobs WHERE hash = ANY($1::text[]) AND size_bytes > 1000000`, [hashes]);
  });
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id;
  });

  it("saves the drawing the patch describes, and the answer carries it", async () => {
    const id = await newNote();
    const v1 = page(strokes(0, 50));
    await whole(id, "ink_data", v1);
    const v2 = page(strokes(0, 51));
    const res = await patch(id, "ink_data", v1, v2);
    expect(res.status).toBe(200);
    expect(await stored(id, "ink_data")).toBe(v2);
    expect(((await res.json()) as { value: string }).value).toBe(v2);
  });

  it("the first drawing of a note (no stored value, empty base) is saved by a patch too", async () => {
    const id = await newNote();
    const v1 = page(strokes(0, 3));
    expect((await patch(id, "ink_data", "", v1)).status).toBe(200);
    expect(await stored(id, "ink_data")).toBe(v1);
  });

  it("a base another device already moved past still merges: both devices' strokes stay", async () => {
    const id = await newNote();
    const base = page(strokes(0, 50));
    await whole(id, "ink_data", base);
    await whole(id, "ink_data", page([...strokes(0, 50), stroke("laptop")]), base); // the laptop saved first
    const res = await patch(id, "ink_data", base, page([...strokes(0, 50), stroke("tablet")])); // the tablet's queue replays
    expect(res.status).toBe(200);
    expect(ids(await stored(id, "ink_data")).sort()).toEqual([...ids(base), "laptop", "tablet"].sort());
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT'`, [id])).rows).toHaveLength(0);
  });

  it("answers 409 patch_base_unknown for a base this note never had, and changes nothing", async () => {
    const id = await newNote();
    const v1 = page(strokes(0, 5));
    await whole(id, "ink_data", v1);
    const res = await patch(id, "ink_data", page(strokes(100, 5)), page(strokes(100, 6)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "patch_base_unknown" });
    expect(await stored(id, "ink_data")).toBe(v1);
  });

  it("another note's drawing cannot be used as a base", async () => {
    const mine = await newNote();
    const theirs = await newNote();
    const secret = page(strokes(500, 20));
    await whole(theirs, "ink_data", secret);
    await whole(theirs, "ink_data", page(strokes(500, 21)), secret);
    await whole(mine, "ink_data", page(strokes(0, 2)));
    expect((await patch(mine, "ink_data", secret, secret)).status).toBe(409);
  });

  it("refuses a patch for a key that is not merged, a patch with value or base_value, and bad hunks", async () => {
    const id = await newNote();
    const v1 = page(strokes(0, 2));
    await whole(id, "ink_data", v1);
    expect((await patch(id, "notes_misc", "", "x")).status).toBe(400);
    expect((await put(id, "ink_data", { value: v1, value_patch: makePatch(v1, v1) })).status).toBe(400);
    expect((await put(id, "ink_data", { value_patch: makePatch(v1, v1), base_value: v1 })).status).toBe(400);
    expect((await put(id, "ink_data", { value_patch: { base_hash: "zz", hunks: [] } })).status).toBe(400);
    const outside = makePatch(v1, v1);
    outside.hunks.push({ at: v1.length + 9, del: 0, ins: "x" });
    expect((await put(id, "ink_data", { value_patch: outside })).status).toBe(400);
    expect(await stored(id, "ink_data")).toBe(v1);
  });

  it("10,000 strokes plus one: the request is under 50 KB", async () => {
    const id = await newNote();
    bigNotes.push(id);
    const v1 = page(strokes(0, 10_000));
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, 'ink_data', $3, 'text')`, [await getWorkspaceId(), id, v1]);
    const v2 = page(strokes(0, 10_001));
    const body = { value_type: "text", is_inheritable: false, value_patch: makePatch(v1, v2) };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const wholeBytes = Buffer.byteLength(JSON.stringify({ value_type: "text", is_inheritable: false, value: v2, base_value: v1 }));
    console.log(`[size] 10,000 strokes: whole+base ${wholeBytes} B, patch ${bytes} B`);
    expect(bytes).toBeLessThan(50 * 1024);
    expect((await put(id, "ink_data", body)).status).toBe(200);
    expect(await stored(id, "ink_data")).toBe(v2);
  });

  it("30,000 strokes (past the request cap as a whole): a stale base still merges, the merge is not dropped", async () => {
    const id = await newNote();
    bigNotes.push(id);
    const base = page(strokes(0, 30_000));
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, 'ink_data', $3, 'text')`, [await getWorkspaceId(), id, base]);
    const laptop = page([...strokes(0, 30_000), stroke("laptop")]);
    const tablet = page([...strokes(0, 30_000), stroke("tablet")]);
    const wholeBytes = Buffer.byteLength(JSON.stringify({ value: tablet, base_value: base }));
    console.log(`[size] 30,000 strokes: whole+base ${wholeBytes} B`);
    expect((await patch(id, "ink_data", base, laptop)).status).toBe(200);
    const bytes = Buffer.byteLength(JSON.stringify({ value_patch: makePatch(base, tablet) }));
    expect(bytes).toBeLessThan(50 * 1024);
    expect((await patch(id, "ink_data", base, tablet)).status).toBe(200);
    const merged = ids(await stored(id, "ink_data"));
    expect(merged).toHaveLength(30_002);
    expect(merged).toContain("laptop");
    expect(merged).toContain("tablet");
  }, 120_000);

  describe("page_text", () => {
    const box = (id: string, text: string): PageTextBox => ({ id, x: 10, y: 20, w: 300, text, size: 22, color: "#15130d", align: "left", updated_at: "2026-10-28T00:00:00.000Z" });
    const doc = (...boxes: PageTextBox[]) => encodePageText({ v: 1, pages: { "pdf:1": { boxes } } });

    it("saves by patch when the base is the stored value; a stale base is 409 (the writer then sends the whole)", async () => {
      const id = await newNote();
      const v1 = doc(box("a", "one"));
      await whole(id, "page_text", v1);
      const v2 = doc(box("a", "one"), box("b", "two"));
      expect((await patch(id, "page_text", v1, v2)).status).toBe(200);
      expect(await stored(id, "page_text")).toBe(v2);
      // the writer's base is a value this server no longer holds and never kept
      const stale = await patch(id, "page_text", doc(box("z", "old")), doc(box("z", "old"), box("c", "three")));
      expect(stale.status).toBe(409);
      const fallback = await whole(id, "page_text", doc(box("a", "one"), box("c", "three")), v1);
      expect(fallback.status).toBe(200);
      expect(await stored(id, "page_text")).toContain("three");
      expect(await stored(id, "page_text")).toContain("two");
    });
  });
});
