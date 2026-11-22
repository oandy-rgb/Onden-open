// A note's list of pages (`note_pages`) and the text of its PDF pages (`pdf_text`) on the server: a save that names its base
// merges into what another device stored (services/attributeWrites.ts MERGED_KEYS, @onden/markdown/note-pages mergeNotePages),
// a value that is not a list is refused, the lean bootstrap carries the list and not the text, search finds the text, an agent
// is told a sentence, a copy and the Markdown export treat both like the note's other data attributes.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { exportedNoteFile } from "../services/exportZip.js";
import { pdfTextOf, pdfTextPageCount } from "../services/pdfText.js";
import type { ActorCtx } from "../types.js";
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

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

const FILE = "/api/media/test-note-pages.pdf";
const list = (...runs: unknown[]) => JSON.stringify({ version: 1, runs });
const blank = (id: string) => ({ id, kind: "blank" });
const pdf = (id: string, from: number, to: number | null, extra: Record<string, unknown> = {}) => ({ id, kind: "pdf", file: FILE, from, to, ...extra });

let defaultSpaceId = "";
let workspaceId = "";
const stamp = `${Date.now()}`;

async function newNote(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `${title} ${stamp}`, markdown: "x", ...extra } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function put(nodeId: string, key: string, value: string, base?: string): Promise<Response> {
  return req(`/api/nodes/${nodeId}/attributes/${key}`, {
    method: "PUT", json: { value, value_type: "text", is_inheritable: false, ...(base !== undefined ? { base_value: base } : {}) },
  });
}
async function stored(nodeId: string, key: string): Promise<string | null> {
  return (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0]?.value ?? null;
}
const idsOf = (value: string | null) => (JSON.parse(value ?? "{}") as { runs: Array<{ id: string }> }).runs.map((r) => r.id);

beforeAll(async () => {
  if (!isTestDb) return;
  await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
  workspaceId = await getWorkspaceId();
  defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
});

describe.skipIf(!isTestDb)("note_pages and pdf_text on the server", () => {
  it("two devices add a page from the same base: both pages stay, no conflict is recorded", async () => {
    const id = await newNote("pages merge");
    const base = list(blank("b1"), pdf("r1", 1, 3));
    expect((await put(id, "note_pages", base)).status).toBe(200);
    expect((await put(id, "note_pages", list(blank("b1"), blank("x"), pdf("r1", 1, 3)), base)).status).toBe(200); // laptop
    const tablet = await put(id, "note_pages", list(blank("b1"), pdf("r1", 1, 3), blank("y")), base); // tablet, replayed
    expect(tablet.status).toBe(200);
    const body = (await tablet.json()) as { value: string; conflict?: unknown };
    expect(idsOf(await stored(id, "note_pages"))).toEqual(["b1", "x", "r1", "y"]);
    expect(idsOf(body.value)).toEqual(["b1", "x", "r1", "y"]); // the answer carries the merge
    expect(body.conflict).toBeUndefined();
    const events = await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT'`, [id]);
    expect(events.rows).toEqual([]);
  });

  it("two devices cut the same run at once: each page once, ids unique", async () => {
    const id = await newNote("pages cut");
    const base = list(pdf("r1", 1, 10));
    expect((await put(id, "note_pages", base)).status).toBe(200);
    expect((await put(id, "note_pages", list(pdf("r1", 1, 5), blank("p1"), pdf("p2", 6, 10, { keyPrefix: "r1" })), base)).status).toBe(200);
    expect((await put(id, "note_pages", list(pdf("r1", 1, 3), blank("q1"), pdf("q2", 4, 10, { keyPrefix: "r1" })), base)).status).toBe(200);
    const { runs } = JSON.parse((await stored(id, "note_pages"))!) as { runs: Array<{ id: string; kind: string; from?: number; to?: number | null }> };
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
    const pdfPages = runs.filter((r) => r.kind === "pdf").flatMap((r) => Array.from({ length: (r.to ?? 0) - (r.from ?? 0) + 1 }, (_, i) => (r.from ?? 0) + i));
    expect(pdfPages.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("a save without a base stays last-writer-wins; a value that is not a list is refused; a newer version is kept", async () => {
    const id = await newNote("pages validation");
    expect((await put(id, "note_pages", list(blank("a")))).status).toBe(200);
    expect((await put(id, "note_pages", list(blank("b")))).status).toBe(200);
    expect(idsOf(await stored(id, "note_pages"))).toEqual(["b"]);
    expect((await put(id, "note_pages", "not json")).status).toBe(400);
    expect((await put(id, "note_pages", list(blank("a"), blank("a")))).status).toBe(400);
    expect((await put(id, "note_pages", list(pdf("r1", 1, 5), pdf("r2", 5, 9, { keyPrefix: "r1" })))).status).toBe(400);
    expect(idsOf(await stored(id, "note_pages"))).toEqual(["b"]);
    const newer = JSON.stringify({ version: 2, runs: "future" });
    expect((await put(id, "note_pages", newer)).status).toBe(200);
    expect(await stored(id, "note_pages")).toBe(newer);
    // A save made from a base is a merge: a list of a version this server does not read is neither merged nor replaced, and the writer is told.
    const merging = await put(id, "note_pages", list(blank("c")), list(blank("b")));
    expect(merging.status).toBe(409);
    expect(((await merging.json()) as { error?: string }).error).toBe("pages_version");
    expect(await stored(id, "note_pages")).toBe(newer);
    expect((await put(id, "pdf_text", "[1]")).status).toBe(400);
    expect((await put(id, "pdf_text", JSON.stringify({ "r1:1": 5 }))).status).toBe(400);
    expect((await put(id, "pdf_text", JSON.stringify({ "r1:1": "ok" }))).status).toBe(200);
  });

  it("an agent is told a sentence in place of the stored list, and nothing of the PDF text; a note made before says its pdf_url as one run", async () => {
    const id = await newNote("pages agent");
    expect((await put(id, "note_pages", list(blank("b1"), pdf("r1", 1, 3), blank("b2")))).status).toBe(200);
    expect((await put(id, "pdf_text", JSON.stringify({ "r1:1": "secret text", "r1:2": "more" }))).status).toBe(200);
    const system = (await q<ActorCtx>(`SELECT id::text, name, type FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!;
    const read = async (nodeId: string) => (await callTool("getNode", { id: nodeId }, { actor: system, workspaceId, dryRun: false }) as { attributes: Array<{ key: string; value: string }> }).attributes;
    const attrs = await read(id);
    expect(attrs.find((a) => a.key === "note_pages")?.value).toBe("5 pages: blank, PDF 1-3, blank");
    expect(attrs.find((a) => a.key === "pdf_text")?.value).toBe("text of 2 pages");
    expect(JSON.stringify(attrs)).not.toContain("secret text");
    const old = await newNote("pages old pdf");
    expect((await put(old, "pdf_url", FILE)).status).toBe(200);
    expect((await read(old)).find((a) => a.key === "note_pages")?.value).toBe("pages: PDF 1-end");
  });

  it("a copy of the note keeps its list of pages and its PDF text", async () => {
    const id = await newNote("pages copy");
    const pages = list(blank("b1"), pdf("r1", 1, 2));
    const text = JSON.stringify({ "r1:1": "copied text" });
    // As the note's owner saved them in the app (a write over the test API is not a person's: source `dispatcher`).
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'note_pages',$3,'text','ui'), ($1,$2,'pdf_text',$4,'text','ui')`, [workspaceId, id, pages, text]);
    const res = await req(`/api/nodes/${id}/duplicate`, { method: "POST", json: {} });
    expect(res.status).toBe(201);
    const copy = ((await res.json()) as { id: string }).id;
    expect(await stored(copy, "note_pages")).toBe(pages);
    expect(await stored(copy, "pdf_text")).toBe(text);
  });

  it("the PDF a list names is owned by the note that saved it, and is still referenced after the list stops naming other files", async () => {
    const file = `notepages${stamp}.pdf`;
    const actor = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!;
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)`, [file, workspaceId, actor.id]);
    const id = await newNote("pages media");
    expect((await put(id, "note_pages", JSON.stringify({ version: 1, runs: [{ id: "r1", kind: "pdf", file: `/api/media/${file}`, from: 1, to: null }] }))).status).toBe(200);
    const owner = (await q<{ node_id: string | null }>(`SELECT node_id::text FROM media_uploads WHERE filename = $1`, [file])).rows[0]?.node_id;
    expect(owner).toBe(id);
    const { mediaReferences } = await import("../services/mediaOwners.js");
    expect((await mediaReferences(workspaceId, file)).map((r) => r.id)).toEqual([id]);
  });
});

describe.skipIf(!isTestDb)("what leaves the server", () => {
  it("the Markdown export writes neither attribute into the frontmatter", () => {
    const file = exportedNoteFile({ id: "11111111-1111-1111-1111-111111111111", title: "T", slug: "t", tags: [] } as never, [
      { key: "note_pages", value: list(blank("b1")), source: "ui" },
      { key: "pdf_text", value: JSON.stringify({ "r1:1": "text" }), source: "ui" },
      { key: "mood", value: "calm", source: "ui" },
    ], "body");
    expect(file).toContain("mood: calm");
    expect(file).not.toContain("note_pages");
    expect(file).not.toContain("pdf_text");
  });

  it("pdf text is read as one text, a page a line; a value that is not a page map has none", async () => {
    const text = async (value: string) => {
      const id = await newNote("pdf text plain");
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'pdf_text',$3,'text','ui')`, [workspaceId, id, value]);
      return pdfTextOf(workspaceId, id);
    };
    expect(await text(JSON.stringify({ "r1:1": "a", "r1:2": "b" }))).toBe("a\nb");
    expect(pdfTextPageCount(JSON.stringify({ "r1:1": "a", "r1:2": "b" }))).toBe(2);
    for (const bad of ["{", "[1]", "3"]) expect(await text(bad)).toBe("");
    expect(pdfTextPageCount(null)).toBe(0);
  });
});
