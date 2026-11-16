// Real sql.js worker RPCs and exported/reopened databases. Only IndexedDB's
// save boundary is controlled to reproduce disk failure and delayed commits.
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import initSqlJs from "sql.js";
import type { Bootstrap } from "../lib/api";
import type { AppliedSyncDelta, PendingWrite } from "../lib/localDb";
import { applySyncDelta } from "../lib/data/storeOps";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null, save: vi.fn() }));
vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: disk.save }));
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});
type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
function rpc(op: string, ...args: unknown[]) {
  const id = ++sequence;
  return new Promise<Reply>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: null } }); });
}
async function ok(op: string, ...args: unknown[]) {
  const reply = await rpc(op, ...args);
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
// A row queued by this build records what it acts on (D45); the legacy row does not.
const queued = (id = 1) => ({ id, method: "PATCH", path: "/api/nodes/n", body: input, idem_key: id === 23 ? "legacy-key" : "original-key", attempts: id === 23 ? 5 : 0,
  ...(id === 23 ? {} : { targets: [{ kind: "node", id: "n" }] }) });
const refused = () => ({ ...queued(), rejection: "Denied" });
const input = '{"markdown":"撤權之後也不能遺失的文字"}';
const node = { id: "n", source_type: "manual", node_type: "content", title: "Private note", slug: "private-note", markdown: "old body", parent_id: null, hidden: false, order_key: "a0" };
const empty = { last_event_id: 7, nodes: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
const bootstrap = { workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [node], tasks: [], edges: [], suggestions: [], events: [] };

async function savedRows() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(disk.bytes!));
  const rows = db.exec("SELECT id,body,idem_key,rejection FROM pending_writes ORDER BY id")[0]?.values ?? [];
  db.close(); return rows;
}
async function reopenWorker() {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await ok("initLocalDb");
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  disk.bytes = null;
  disk.save.mockReset().mockImplementation(async (bytes: ArrayBuffer) => { disk.bytes = bytes; });
  await reopenWorker();
  await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "original-key");
});

describe("directly refused input", () => {
  const request = { method: "PATCH", path: "/api/nodes/n", body: '{"markdown":"directly refused draft"}', idem_key: "direct-key" };
  it("persists outside replay, survives reopening, and deduplicates only the same request", async () => {
    const row = await ok("storeRejectedWrite", request, "Denied");
    expect(await ok("getPendingWrites")).toEqual([queued()]);
    await reopenWorker();
    expect(await ok("getRejectedWrites")).toEqual([row]);
    expect(await ok("storeRejectedWrite", request, "Denied")).toEqual(row);
    expect((await rpc("storeRejectedWrite", { ...request, body: "different input" }, "Denied")).ok).toBe(false);
    expect(await ok("getRejectedWrites")).toEqual([row]);
  });
  it("waits for disk and rolls back failed recovery persistence without creating replayable work", async () => {
    disk.save.mockRejectedValueOnce(new Error("disk full"));
    expect((await rpc("storeRejectedWrite", request, "Denied")).ok).toBe(false);
    expect(await ok("getRejectedWrites")).toEqual([]);
    expect(await ok("getPendingWrites")).toEqual([queued()]);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    disk.save.mockImplementationOnce(async bytes => { await hold; disk.bytes = bytes; });
    let completed = false;
    const saving = rpc("storeRejectedWrite", request, "Denied").then(reply => { completed = true; return reply; });
    await vi.waitFor(() => expect(disk.save).toHaveBeenCalledTimes(3));
    const settledEarly = completed;
    release();
    expect((await saving).ok).toBe(true);
    expect(settledEarly).toBe(false);
    await reopenWorker();
    expect(await ok("getRejectedWrites")).toHaveLength(1);
  });
});

describe("pending note text during remote hydration", () => {
  it("offline cold start projects durable input even if the content mirror was never updated", async () => {
    await ok("clearPendingWrite", 1);
    await ok("persistBootstrap", bootstrap);
    await ok("flushLocalDbSync");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "cold-start-key");
    // Enqueue saved the old mirror plus the new request; no optimistic upsert.
    await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ markdown: "撤權之後也不能遺失的文字" })] });
  });

  it.each(["full", "none"])("%s bootstrap returns and persists pending text instead of an older server value", async bodies => {
    const projected = await ok("persistBootstrap", { ...bootstrap, bodies });
    expect(projected).toMatchObject({ nodes: [expect.objectContaining({ markdown: "撤權之後也不能遺失的文字", title: "Private note" })] });
    await ok("flushLocalDbSync"); await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ markdown: "撤權之後也不能遺失的文字" })] });
    expect(await ok("getPendingWrites")).toEqual([queued()]);
  });

  it("delta hydration keeps the latest queued text, while accepting unrelated remote metadata", async () => {
    await ok("persistBootstrap", bootstrap);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", JSON.stringify({ title: "本機改名", markdown: "", base_markdown: "not the pending text" }), "latest-key");
    const applied = await ok("applySync", { ...empty, nodes: { upsert: [{ ...node, parent_id: "new-parent", class_tag_ids: ["server-policy"] }], delete: [] } });
    expect(applied).toMatchObject({ nodes: { upsert: [expect.objectContaining({ title: "本機改名", markdown: "", parent_id: "new-parent", class_tag_ids: ["server-policy"] })] } });
    await ok("flushLocalDbSync"); await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ title: "本機改名", markdown: "" })] });
    expect(await ok("getPendingWrites")).toHaveLength(2);
  });

  it("slim bootstrap cannot retain a revoked existing note because a pending PATCH mentions its id", async () => {
    await ok("upsertNode", node);
    await ok("upsertAttribute", "n", "ink", "private cached ink");
    await ok("persistBootstrap", { ...bootstrap, nodes: [], bodies: "none" });
    expect(await ok("getAllMembershipIds")).toEqual([]);
    expect(await ok("getNodeAttribute", "n", "ink")).toBeNull();
    expect(await ok("getPendingWrites")).toEqual([queued()]);
  });

  it("an intentional empty pending body clears the cached body even in a slim response", async () => {
    await ok("upsertNode", node);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":""}', "empty-key");
    expect(await ok("persistBootstrap", { ...bootstrap, nodes: [{ ...node, markdown: "", body_len: 50 }], bodies: "none" }))
      .toMatchObject({ nodes: [expect.objectContaining({ markdown: "", body_len: 0 })] });
    await ok("flushLocalDbSync"); await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ markdown: "" })] });
  });

  it("single-node lazy hydration follows the same pending text contract", async () => {
    expect(await ok("persistRemoteNode", node)).toMatchObject({ markdown: "撤權之後也不能遺失的文字" });
    await ok("persistBootstrap", bootstrap);
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ markdown: "撤權之後也不能遺失的文字" })] });
  });

  it("after rejection or acknowledgement, later remote text wins without reviving old input", async () => {
    await ok("rejectPendingWrite", queued(), "Denied");
    expect(await ok("persistBootstrap", bootstrap)).toMatchObject({ nodes: [expect.objectContaining({ markdown: "old body" })] });
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"accepted later"}', "second-key");
    await ok("clearPendingWrite", 2);
    expect(await ok("applySync", { ...empty, nodes: { upsert: [node], delete: [] } })).toMatchObject({ nodes: { upsert: [expect.objectContaining({ markdown: "old body" })] } });
    expect(await ok("getRejectedWrites")).toHaveLength(1);
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("pending note creation across startup and membership reconciliation", () => {
  const createInput = JSON.stringify({ id: "n", title: "2026-09-15", markdown: "own draft", source_type: "manual", node_type: "content" });
  const own = { id: "n", title: "2026-09-15", markdown: "own draft", body_len: 9, slug: "2026-09-15", source_type: "manual", node_type: "content" };
  beforeEach(async () => {
    await ok("clearPendingWrite", 1);
    await ok("persistBootstrap", { ...bootstrap, nodes: [] });
    await ok("addPendingWrite", "POST", "/api/nodes", createInput, "create-key");
  });

  it("cold start restores a durable create even before its optimistic mirror exists", async () => {
    await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [own] });
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ body: createInput, idem_key: "create-key" })]);
  });

  it.each(["full", "none"])("%s hydration returns the same pending note through repeated reloads", async bodies => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"continued draft"}', "edit-key");
    for (let reload = 0; reload < 2; reload++) {
      expect(await ok("persistBootstrap", { ...bootstrap, nodes: [], bodies }))
        .toMatchObject({ nodes: [{ ...own, markdown: "continued draft", body_len: 15 }] });
      await ok("flushLocalDbSync"); await reopenWorker();
      expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ id: "n", markdown: "continued draft" })] });
      expect(await ok("getPendingWrites")).toHaveLength(2);
    }
  });

  it.each(["sync", "none"])("%s removes old same-ID private metadata and relations but preserves own create input", async channel => {
    const remote = { ...node, parent_id: "private-parent", class_tag_ids: ["private-tag"], attrs: { ink: "private-ink" } };
    const edge = { id: "e", source_node_id: "n", target_node_id: "peer", edge_type: "ref", status: "active" };
    const task = { id: "task", node_id: "n", title: "private task", status: "todo" };
    await ok("persistBootstrap", { ...bootstrap, nodes: [remote], edges: [edge], tasks: [task] });
    if (channel === "sync") {
      const applied = await ok("applySync", { ...empty, nodes: { upsert: [], delete: ["n"] },
        edges: { upsert: [edge], delete: [] }, tasks: { upsert: [task], delete: [] },
        attributes: { upsert: [{ node_id: "n", key: "ink", value: "late-private-ink", value_type: "text", is_inheritable: false, source: "explicit" }], delete: [] },
      }) as AppliedSyncDelta;
      expect(applied.pendingCreations).toEqual([own]);
      expect(applySyncDelta({ ...bootstrap, nodes: [remote], edges: [edge], tasks: [task] } as Bootstrap, applied))
        .toMatchObject({ nodes: [own], edges: [], tasks: [] });
    } else {
      expect(await ok("persistBootstrap", { ...bootstrap, nodes: [], bodies: "none" })).toMatchObject({ nodes: [own] });
    }
    await ok("flushLocalDbSync"); await reopenWorker();
    expect(await ok("getNodeAttribute", "n", "ink")).toBeNull();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [expect.objectContaining({ title: own.title, markdown: own.markdown, parent_id: null, attrs: {}, class_tag_ids: [] })], edges: [], tasks: [] });
  });

  it("acknowledgement and rejection stop recreating the note, while rejected input remains recoverable", async () => {
    const [create] = await ok("getPendingWrites") as PendingWrite[];
    await ok("rejectPendingWrite", create, "Denied");
    expect(await ok("persistBootstrap", { ...bootstrap, nodes: [] })).toMatchObject({ nodes: [] });
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: createInput })]);
    await ok("addPendingWrite", "POST", "/api/nodes", createInput, "next-create-key");
    const [retry] = await ok("getPendingWrites") as PendingWrite[];
    await ok("clearPendingWrite", retry.id);
    expect(await ok("applySync", empty)).toMatchObject({ pendingCreations: [] });
  });

  it("a later queued delete and a forged wire field cannot resurrect a new note", async () => {
    await ok("addPendingWrite", "DELETE", "/api/nodes/n", null, "delete-key");
    expect(await ok("persistBootstrap", { ...bootstrap, nodes: [] })).toMatchObject({ nodes: [] });
    expect(await ok("applySync", { ...empty, pendingCreations: [{ ...node, markdown: "not own input" }] }))
      .toMatchObject({ pendingCreations: [] });
    await reopenWorker();
    expect(await ok("loadBootstrap")).toMatchObject({ nodes: [] });
  });
});

describe("durable rejected input", () => {
  it("preserves input and its key after reopening, and removes only rejected rows from replay", async () => {
    await ok("addPendingWrite", "POST", "/api/nodes", '{"title":"unrelated"}', "other-key");
    await ok("rejectPendingWrite", queued(), "Permission revoked");
    await reopenWorker(); // new SQL instance opened from the last persisted bytes
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ id: 2, idem_key: "other-key" })]);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ id: 1, body: input, idem_key: "original-key", rejection: "Permission revoked" })]);
  });

  it("does not acknowledge the transition until its snapshot is saved", async () => {
    let commit!: () => void;
    disk.save.mockImplementationOnce((bytes: ArrayBuffer) => new Promise<void>(resolve => {
      commit = () => { disk.bytes = bytes; resolve(); };
    }));
    let completed = false;
    const rejecting = rpc("rejectPendingWrite", queued(), "Denied").then(reply => { completed = true; return reply; });
    await vi.waitFor(() => expect(commit).toBeTypeOf("function"));
    expect(completed).toBe(false);
    expect(await savedRows()).toEqual([[1, input, "original-key", null]]);
    commit();
    expect((await rejecting).ok).toBe(true);
    expect(await savedRows()).toEqual([[1, input, "original-key", "Denied"]]);
  });

  it("keeps the original pending row in memory and on disk when preservation fails", async () => {
    disk.save.mockRejectedValueOnce(new Error("disk full"));
    expect((await rpc("rejectPendingWrite", queued(), "Denied")).ok).toBe(false);
    expect(await ok("getRejectedWrites")).toEqual([]);
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ id: 1, body: input, idem_key: "original-key" })]);
    await ok("flushLocalDbSync"); // later background/unload saves must not persist a broken transition
    await reopenWorker();
    expect(await savedRows()).toEqual([[1, input, "original-key", null]]);
  });

  it("a rejected input cannot keep revoked note, task, edge or attribute rows readable", async () => {
    await ok("upsertNode", node);
    await ok("upsertTask", { id: "task", node_id: "n", title: "task", status: "todo" });
    await ok("upsertAttribute", "n", "ink", "sensitive cached ink");
    await ok("upsertEdge", { id: "edge", source_node_id: "n", target_node_id: "peer", edge_type: "ref", status: "active" });
    await ok("rejectPendingWrite", queued(), "Denied");
    await ok("applySync", { ...empty, nodes: { upsert: [], delete: ["n"] } });
    await ok("flushLocalDbSync");
    await reopenWorker();
    expect(await ok("getAllMembershipIds")).toEqual([]);
    expect(await ok("getNodeAttribute", "n", "ink")).toBeNull();
    const SQL = await initSqlJs(); const db = new SQL.Database(new Uint8Array(disk.bytes!));
    expect(db.exec("SELECT count(*) FROM edges")[0].values[0][0]).toBe(0); db.close();
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: input })]);
  });

  it("slim bootstrap also drops a revoked mirror despite the retained request path", async () => {
    await ok("upsertNode", node);
    await ok("rejectPendingWrite", queued(), "Denied");
    await ok("persistBootstrap", { workspace: { id: "w", name: "Test", slug: "test" }, actor_role: "viewer",
      nodes: [], tasks: [], edges: [], suggestions: [], events: [], bodies: "none" });
    expect(await ok("getAllMembershipIds")).toEqual([]);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: input })]);
  });

  it("a stale acknowledgement cannot erase a rejected recovery entry", async () => {
    await ok("rejectPendingWrite", queued(), "Denied");
    await ok("clearPendingWrite", 1);
    expect(await ok("getRejectedWrites")).toHaveLength(1);
  });

  it("failed dismissal keeps the entry recoverable after a later save and reopen", async () => {
    await ok("rejectPendingWrite", queued(), "Denied");
    disk.save.mockRejectedValueOnce(new Error("disk full"));
    expect((await rpc("dismissRejectedWrite", refused())).ok).toBe(false);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: input })]);
    await ok("flushLocalDbSync"); await reopenWorker();
    expect(await savedRows()).toEqual([[1, input, "original-key", "Denied"]]);
  });

  it("dismissal persists, is repeatable, and cannot remove an active pending write", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/other", "other", "other-key");
    await ok("rejectPendingWrite", queued(), "Denied");
    await ok("dismissRejectedWrite", { ...refused(), id: 2 }); // active pending entry is not a recovery copy
    await ok("dismissRejectedWrite", refused()); await ok("dismissRejectedWrite", refused());
    await reopenWorker();
    expect(await ok("getRejectedWrites")).toEqual([]);
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ id: 2, body: "other" })]);
  });

  it("upgrades a legacy queue without changing its request, order, attempts or key", async () => {
    const SQL = await initSqlJs(); const legacy = new SQL.Database();
    legacy.run("CREATE TABLE pending_writes(id INTEGER PRIMARY KEY AUTOINCREMENT,method TEXT,path TEXT,body TEXT,idem_key TEXT,attempts INTEGER,created_at TEXT)");
    legacy.run("INSERT INTO pending_writes VALUES(23,'PATCH','/api/nodes/n',?,'legacy-key',5,'2026-01-01')", [input]);
    disk.bytes = legacy.export().buffer as ArrayBuffer; legacy.close();
    await reopenWorker();
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ id: 23, body: input, attempts: 5, idem_key: "legacy-key" })]);
    expect((await ok("getPendingWrites") as Array<{ targets?: unknown }>)[0].targets).toBeUndefined();
    expect(await ok("getRejectedWrites")).toEqual([]);
    await ok("rejectPendingWrite", queued(23), "Denied"); await reopenWorker();
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ id: 23, body: input, attempts: 5, idem_key: "legacy-key" })]);
  });
  it("a stale response or recovery card cannot change a reused row id after backup replacement", async () => {
    const stale = queued();
    const SQL = await initSqlJs(); const replaced = new SQL.Database(new Uint8Array(disk.bytes!));
    replaced.run("UPDATE pending_writes SET body='a different restored input',idem_key=NULL WHERE id=1");
    disk.bytes = replaced.export().buffer as ArrayBuffer; replaced.close();
    await reopenWorker();
    expect((await rpc("rejectPendingWrite", stale, "Denied")).ok).toBe(false);
    const current = (await ok("getPendingWrites") as ReturnType<typeof queued>[])[0];
    await ok("rejectPendingWrite", current, "Denied");
    expect((await rpc("dismissRejectedWrite", { ...stale, rejection: "Denied" })).ok).toBe(false);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: "a different restored input", idem_key: null })]);
  });

});
