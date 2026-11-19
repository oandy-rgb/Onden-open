// The side bar's on-device search: a note whose title is the typed text, then
// one whose title starts with it, come before the FTS rank (perf report
// 2026-10-21, minor findings: "筆記 42" was not among the first 50 of 20k).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { prepareLocalDatabase } from "../lib/localDbSchema";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; } }));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: { ok: boolean; result?: unknown; error?: string }) => void>();

function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    replies.set(id, (reply) => (reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error))));
    receive({ data: { id, op, args, storageScope: null } });
  });
}


const NOTES: Array<[id: string, title: string, markdown: string]> = [
  ["body-heavy", "Streams overview", "kafka ".repeat(60)],
  ["contains", "About Kafka streams", "kafka kafka kafka kafka kafka kafka"],
  ["prefix", "Kafka streams primer", "kafka kafka kafka"],
  ["exact", "Kafka", "short"],
  ["exact-other-case", "KAFKA", "short too"],
  ["percent", "100% done", "kafka"],
  ["percent-prefix", "100% done and more", "kafka"],
  ["other", "Unrelated", "nothing to see"],
];

async function snapshot(): Promise<ArrayBuffer> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO workspace (id, name, slug) VALUES ('w', 'Test', 'test')");
  for (const [id, title, markdown] of NOTES) {
    db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES (?, 'local', 'content', ?, ?, ?)", [id, title, id, markdown]);
  }
  // A note whose only mention of "mitochondria" is in a text box on its page.
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('typed', 'local', 'content', 'Slides', 'typed', '')");
  const boxes = JSON.stringify({ v: 1, pages: { "pdf:1": { boxes: [{ id: "b", x: 0, y: 0, w: 300, text: "The mitochondria 粒線體 is the powerhouse", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
  db.run("INSERT INTO node_attributes (node_id, key, value) VALUES ('typed', 'page_text', ?)", [boxes]);
  // A PDF note: the text of its pages is in `pdf_text` (the server's search reads it; this device's index does not, see below).
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('lecture', 'local', 'content', 'Lecture slides', 'lecture', '')");
  db.run("INSERT INTO node_attributes (node_id, key, value) VALUES ('lecture', 'pdf_text', ?)", [JSON.stringify({ "r1:1": "Photosynthesis happens in the chloroplast" })]);
  const bytes = db.export().buffer as ArrayBuffer;
  db.close();
  return bytes;
}

type Row = { id: string };
const ids = async (query: string) => (await rpc<Row[]>("searchNodes", query)).map((r) => r.id);

beforeAll(async () => { disk.bytes = await snapshot(); });

beforeEach(async () => {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await rpc("initLocalDb");
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); });

describe("local search ranking (on-device index)", () => {
  it("puts a title equal to the query first, then titles that start with it, then the FTS rank", async () => {
    const found = await ids("kafka");
    expect(new Set(found.slice(0, 2))).toEqual(new Set(["exact", "exact-other-case"]));
    expect(found[2]).toBe("prefix");
    expect(new Set(found)).toEqual(new Set(["exact", "exact-other-case", "prefix", "body-heavy", "contains", "percent", "percent-prefix"]));
  });

  it("ranks the same way on the LIKE fallback (a one-character query is not sent to FTS)", async () => {
    const found = await ids("K");
    expect(new Set(found.slice(0, 3))).toEqual(new Set(["exact", "exact-other-case", "prefix"]));
  });

  it("finds a word that is only in a text box on a page, with a snippet, and not the format's own key names", async () => {
    expect(await ids("mitochondria")).toEqual(["typed"]);
    expect(await ids("粒線體")).toEqual(["typed"]);
    const [hit] = await rpc<Array<{ id: string; snippet: { text: string } | null }>>("searchNodes", "powerhouse");
    expect(hit!.snippet!.text).toContain("powerhouse");
    expect(await ids("boxes")).toEqual([]);
    expect(await ids("updated_at")).toEqual([]);
  });

  it("does not find a word that is only in the text of a PDF's pages (pdf_text): offline search covers titles, text and text boxes, the server's covers PDF text", async () => {
    expect(await ids("photosynthesis")).toEqual([]);
    expect(await ids("chloroplast")).toEqual([]);
    expect(await ids("Lecture slides")).toEqual(["lecture"]); // the note itself is found by its title
  });

  it("reads % in the query literally when it matches a title start", async () => {
    const found = await ids("100% done");
    expect(found.slice(0, 2)).toEqual(["percent", "percent-prefix"]);
  });
});
