// Distributed sync (beta) is off unless ONDEN_DISTRIBUTED_SYNC=1, and "off" leaves no trace: nothing registered, no importer
// outside its own folder and its tests, no route. Doc: docs/architecture/distributed-sync.md §9.
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DistributedSyncOff, distributedSyncEnabled, openSyncNode } from "../distributedSync/index.js";
import { MODULES } from "../modules/index.js";
import type { SyncDb } from "../distributedSync/types.js";
import { Replica } from "../distributedSync/bridge/index.js";
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const noDb: SyncDb = { query: async () => { throw new Error("touched the database"); }, transaction: async () => { throw new Error("touched the database"); } };

describe("off by default", () => {
  const was = process.env.ONDEN_DISTRIBUTED_SYNC;
  afterEach(() => { if (was === undefined) delete process.env.ONDEN_DISTRIBUTED_SYNC; else process.env.ONDEN_DISTRIBUTED_SYNC = was; });

  it("a node cannot be opened, and the database is not touched", async () => {
    delete process.env.ONDEN_DISTRIBUTED_SYNC;
    expect(distributedSyncEnabled()).toBe(false);
    await expect(openSyncNode(noDb, { nodeId: "x", actors: [], directory: {}, now: () => 0 })).rejects.toBeInstanceOf(DistributedSyncOff);
  });
  it("only the value 1 switches it on", () => {
    process.env.ONDEN_DISTRIBUTED_SYNC = "true";
    expect(distributedSyncEnabled()).toBe(false);
    process.env.ONDEN_DISTRIBUTED_SYNC = "1";
    expect(distributedSyncEnabled()).toBe(true);
  });
});

describe("no trace in the running server", () => {
  it("is not a registered module (no route, tool, hook, job or library card) until the interface step", () => {
    expect(MODULES.map((m) => m.id)).not.toContain("distributed_sync");
  });
  it("nothing outside its own folder and its tests imports it", () => {
    const importers = walk(src).filter((f) => f.endsWith(".ts") && !f.includes("/distributedSync/") && !/\/test\//.test(f))
      .filter((f) => /from "[^"]*distributedSync\//.test(readFileSync(f, "utf8"))).map((f) => relative(src, f));
    expect(importers).toEqual([]);
  });
  it("the engine never reaches the process-wide database or the request pipeline", () => {
    // The engine proper (the folder's own files) is pure + an injected SyncDb. Only bridge/ touches the real tables, and only through
    // the services and spine.
    for (const f of walk(join(src, "distributedSync")).filter((p) => p.endsWith(".ts") && !p.includes("/bridge/"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from "\.\.\/db\.js"|from "\.\.\/spine|from "\.\.\/routes|from "\.\.\/services\/(?!eventLog\/index\.js)/);
    }
  });
  it("the bridge does not reach routes; and only the projection can replay an op as its author", () => {
    for (const f of walk(join(src, "distributedSync", "bridge")).filter((p) => p.endsWith(".ts"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from "\.\.\/\.\.\/routes/);
    }
    // withReplicatedOp swaps today's membership for the engine's verdict (spine/replicatedOp.ts): one caller, by construction.
    const callers = walk(src).filter((f) => f.endsWith(".ts") && !/\/test\//.test(f)).filter((f) => /\bwithReplicatedOp\b/.test(readFileSync(f, "utf8"))).map((f) => relative(src, f)).sort();
    expect(callers).toEqual(["distributedSync/bridge/project.ts", "spine/replicatedOp.ts"]);
  });
});

describe.skipIf(process.env.ONDEN_DB_DRIVER !== "pglite" || !isTestDatabase())("off leaves no trace in the tables", () => {
  const was = process.env.ONDEN_DISTRIBUTED_SYNC;
  afterEach(() => { if (was === undefined) delete process.env.ONDEN_DISTRIBUTED_SYNC; else process.env.ONDEN_DISTRIBUTED_SYNC = was; });

  it("a replica cannot be opened, and ordinary writes touch no ds_ table and carry no ds_op_id", async () => {
    delete process.env.ONDEN_DISTRIBUTED_SYNC;
    const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Off',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const actor = (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'solo','human') RETURNING id,name,type", [ws])).rows[0]!;
    await expect(Replica.open({ workspaceId: ws, nodeId: "x" })).rejects.toBeInstanceOf(DistributedSyncOff);
    const created = await createNote({ actor, workspaceId: ws, title: "plain", markdown: "text", event: { uiContext: "t" } });
    await updateNode(ws, created.node.id, { title: "plain 2" }, { actor });
    for (const table of ["ds_node", "ds_ops", "ds_rejections", "ds_peers", "ds_capture_cursor", "ds_captured_events", "ds_unsupported", "ds_projection_failures"]) {
      expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n), table).toBe(0);
    }
    expect(Number((await q<{ n: string }>("SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND tx_meta ? 'ds_op_id'", [ws])).rows[0]!.n)).toBe(0);
  });
});
