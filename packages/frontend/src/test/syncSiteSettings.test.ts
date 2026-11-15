// D119: the sync delta re-ships the site config and chrome after a change
// (SITE_CONFIG_UPDATED). Real sql.js worker RPCs with a simulated disk: the
// mirror stores them as a bootstrap's, the store takes them — except what
// this device is still saving.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { AppliedSyncDelta, SyncDelta } from "../lib/localDb";
import type { Bootstrap } from "../lib/api";
import { applySyncDelta, isEmptyDelta } from "../lib/data/storeOps";
import { optimisticFields } from "../lib/data/optimisticFields";

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
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "admin",
  nodes: [note("a")], edges: [], tasks: [], suggestions: [], events: [],
  site_config: { brand: "Old brand", tagline: "Old tagline" },
  chrome: { blocks: [{ type: "hero", props: { title: "Old header" } }], studio_draft: true, rev: "r1" },
};
const newerChrome = { blocks: [{ type: "hero", props: { title: "Header from tab A" } }], studio_draft: true, rev: "r2" };
const delta = (over: Partial<SyncDelta> = {}): SyncDelta => ({
  last_event_id: 9, nodes: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
  edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
  site_config: { brand: "New brand" }, chrome: newerChrome, ...over,
});
const settingsOf = async () => {
  const loaded = await ok("loadBootstrap") as Bootstrap;
  return { site_config: loaded.site_config, chrome: loaded.chrome };
};

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await ok("persistBootstrap", bootstrap);
});

describe("site settings in the sync delta (D119)", () => {
  it("a settings-only delta is not empty", () => {
    expect(isEmptyDelta(delta())).toBe(false);
    expect(isEmptyDelta(delta({ site_config: undefined, chrome: undefined }))).toBe(true);
  });

  it("the mirror and the store take the re-shipped config and chrome, and keep them across a cold start", async () => {
    const applied = await ok("applySync", delta()) as AppliedSyncDelta;
    expect(await settingsOf()).toEqual({ site_config: { brand: "New brand" }, chrome: newerChrome });
    await ok("flushLocalDbSync");
    await openWorker();
    expect(await settingsOf()).toEqual({ site_config: { brand: "New brand" }, chrome: newerChrome });
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(memory.site_config).toEqual({ brand: "New brand" });
    expect(memory.chrome).toEqual(newerChrome);
  });

  it("a delta without settings leaves them alone", async () => {
    const applied = await ok("applySync", delta({ site_config: undefined, chrome: undefined })) as AppliedSyncDelta;
    expect(await settingsOf()).toEqual({ site_config: bootstrap.site_config, chrome: bootstrap.chrome });
    expect(applySyncDelta(bootstrap as unknown as Bootstrap, applied).chrome).toEqual(bootstrap.chrome);
  });

  it("a design change still queued on this device is not replaced by the server's older one", async () => {
    await ok("addPendingWrite", "PATCH", "/api/workspace/config", JSON.stringify({ chrome: { blocks: [], rev: "mine" } }), "key-1");
    const applied = await ok("applySync", delta()) as AppliedSyncDelta;
    expect(await settingsOf()).toEqual({ site_config: bootstrap.site_config, chrome: bootstrap.chrome });
    expect(applied.site_config).toBeUndefined();
    expect(applySyncDelta(bootstrap as unknown as Bootstrap, applied).chrome).toEqual(bootstrap.chrome);
  });

  it("the store keeps a design edit still waiting for its answer, and takes the rest", () => {
    const local = { ...bootstrap, site_config: { brand: "Saving brand", tagline: "Old tagline" }, chrome: { blocks: [], rev: "mine" } } as unknown as Bootstrap;
    const settleChrome = optimisticFields<Bootstrap>("workspace:w", local, { chrome: local.chrome });
    const settleBrand = optimisticFields("workspace:w:config", local.site_config ?? {}, { brand: "Saving brand" });
    try {
      const memory = applySyncDelta(local, delta({ site_config: { brand: "New brand", tagline: "Remote tagline" } }) as AppliedSyncDelta);
      expect(memory.chrome).toEqual({ blocks: [], rev: "mine" });
      expect(memory.site_config).toEqual({ brand: "Saving brand", tagline: "Remote tagline" });
    } finally { settleChrome(true); settleBrand(true); }
    expect(applySyncDelta(local, delta() as AppliedSyncDelta).chrome).toEqual(newerChrome);
  });
});
