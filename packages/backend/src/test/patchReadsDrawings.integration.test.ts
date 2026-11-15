// The offline drawing download (POST /api/sync/drawings): a device that says
// which copy of a drawing it holds (`have`) gets a patch from that copy when
// this server still has it among the note's own versions, else the whole value.
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { applyPatch, hashText } from "@onden/markdown";

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
const page = (count: number) => JSON.stringify({ version: 1, strokes: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, color: "#000", size: 2, toolId: "pen", points: [[i, i, 0.5], [i + 1, i + 2, 0.5], [i + 3, i + 4, 0.5]] })), erased: {}, page: { width: 1000 } });
const newNote = async () => ((await (await req("/api/nodes", "POST", { space_id: spaceId, title: `drawing read ${randomUUID()}`, markdown: "x" })).json()) as { id: string }).id;
const save = (id: string, value: string, base?: string) => req(`/api/nodes/${id}/attributes/ink_data`, "PUT", { value, value_type: "text", ...(base !== undefined ? { base_value: base } : {}) });
type Row = { node_id: string; key: string; value?: string; value_patch?: { base_hash: string; hunks: unknown[] } };
const download = async (ids: string[], have?: Record<string, string>) =>
  ((await (await req("/api/sync/drawings", "POST", { ids, ...(have ? { have } : {}) })).json()) as { drawings: Row[] }).drawings;

describe.skipIf(!isTestDb)("offline drawing download as a patch", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id;
  });

  it("without `have` the value comes whole, as before", async () => {
    const id = await newNote();
    const v1 = page(200);
    await save(id, v1);
    expect(await download([id])).toMatchObject([{ node_id: id, key: "ink_data", value: v1 }]);
  });

  it("a device holding the previous copy gets the change only, and rebuilds the current value", async () => {
    const id = await newNote();
    const v1 = page(200), v2 = page(201);
    await save(id, v1);
    await save(id, v2, v1);
    const [row] = await download([id], { [`${id}:ink_data`]: hashText(v1) });
    expect(row!.value).toBeUndefined();
    expect(JSON.stringify(row).length).toBeLessThan(v2.length / 10);
    expect(applyPatch(v1, row!.value_patch as never)).toBe(v2);
  });

  it("a copy several saves behind still comes as a patch; one already current comes as an empty patch", async () => {
    const id = await newNote();
    const v1 = page(200), v2 = page(201), v3 = page(202);
    await save(id, v1); await save(id, v2, v1); await save(id, v3, v2);
    const [behind] = await download([id], { [`${id}:ink_data`]: hashText(v1) });
    expect(applyPatch(v1, behind!.value_patch as never)).toBe(v3);
    const [current] = await download([id], { [`${id}:ink_data`]: hashText(v3) });
    expect(current!.value_patch!.hunks).toEqual([]);
  });

  it("a copy this note never had (or another note's) comes whole", async () => {
    const id = await newNote();
    const other = await newNote();
    const secret = page(300);
    await save(other, secret); await save(other, page(301), secret);
    await save(id, page(200));
    expect((await download([id], { [`${id}:ink_data`]: hashText(page(999)) }))[0]!.value).toBe(page(200));
    expect((await download([id], { [`${id}:ink_data`]: hashText(secret) }))[0]!.value).toBe(page(200));
  });

  it("refuses a `have` of the wrong shape", async () => {
    const id = await newNote();
    expect((await req("/api/sync/drawings", "POST", { ids: [id], have: { nope: "x" } })).status).toBe(400);
    expect((await req("/api/sync/drawings", "POST", { ids: [id], have: [1] })).status).toBe(400);
  });
});
