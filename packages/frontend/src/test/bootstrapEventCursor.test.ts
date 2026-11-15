// GAP-249: real sql.js worker. A mirror with no sync cursor adopts the
// bootstrap's event cursor (so a new device does not replay since=0); an
// existing cursor is never moved by a later bootstrap.
import { beforeEach, describe, it, expect, vi } from "vitest";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({
  idbLoad: async () => disk.bytes,
  idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; },
}));
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});
type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
async function ok(op: string, ...args: unknown[]) {
  const id = ++sequence;
  const reply = await new Promise<Reply>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: null } }); });
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
async function openWorker() {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await ok("initLocalDb");
}

const note = (id: string) => ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: null, hidden: false, sort_order: 0 });
const boot = (cursor?: string) => ({
  bodies: "none", ...(cursor === undefined ? {} : { last_event_id: cursor }),
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [note("a")], edges: [], tasks: [], suggestions: [], events: [],
});

beforeEach(async () => { disk.bytes = null; await openWorker(); });

describe("bootstrap event cursor (GAP-249)", () => {
  it("a fresh mirror starts at the bootstrap cursor", async () => {
    expect(await ok("getLastEventId")).toBe(0);
    await ok("persistBootstrap", boot("6266"));
    expect(await ok("getLastEventId")).toBe(6266);
  });

  it("an existing cursor is kept, even when a later bootstrap is ahead", async () => {
    await ok("setLastEventId", 40);
    await ok("persistBootstrap", boot("6266"));
    expect(await ok("getLastEventId")).toBe(40);
  });

  it("an older server without a cursor leaves the mirror at 0", async () => {
    await ok("persistBootstrap", boot());
    expect(await ok("getLastEventId")).toBe(0);
  });

  it("an older bootstrap that lands after newer deltas rewinds the cursor to its own position", async () => {
    await ok("persistBootstrap", boot("100"));
    await ok("applySync", { nodes: { upsert: [{ ...note("a"), title: "NEW" }, note("b")], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, last_event_id: 105 });
    expect(await ok("getLastEventId")).toBe(105);
    // The slow download, taken at event 100, lands now: it replaced the rows
    // with their older state, so the deltas must be replayed from 100.
    await ok("persistBootstrap", boot("100"));
    expect(await ok("getLastEventId")).toBe(100);
  });

  it("a newer bootstrap never moves the cursor forward", async () => {
    await ok("setLastEventId", 40);
    await ok("persistBootstrap", boot("6266"));
    expect(await ok("getLastEventId")).toBe(40);
  });
});

describe("sync cursor writes (monotonic)", () => {
  it("setLastEventId and applySync never lower the cursor", async () => {
    await ok("setLastEventId", 200);
    await ok("setLastEventId", 150);
    expect(await ok("getLastEventId")).toBe(200);
    await ok("applySync", { nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, last_event_id: 150 });
    expect(await ok("getLastEventId")).toBe(200);
    await ok("setLastEventId", "1000");
    expect(await ok("getLastEventId")).toBe(1000);
  });
});
