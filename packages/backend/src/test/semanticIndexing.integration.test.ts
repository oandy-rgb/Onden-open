// Semantic search does something for the person when turned on (modules/semantic/indexing.ts):
//   • turning it on indexes the notes already there, through the outbox, in batches that resume;
//   • turning it off stops the chain; nothing is embedded afterwards;
//   • each note's related-note suggestions are filed on the server and a board's sync carries them;
//   • a note the reader cannot read is never indexed for them, suggested or returned.
// The embedder is the suite's stub (services/embedder.ts; EMBEDDING_MODE under NODE_ENV=test).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

let appWorkspace: string | null = null;
vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  return { ...actual, getWorkspaceId: async () => appWorkspace ?? actual.getWorkspaceId() };
});

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool, q } from "../db.js";
import { mountModules } from "../modules/index.js";
import { semanticModule } from "../modules/semantic/index.js";
import { indexProgress, resumeIndexing } from "../modules/semantic/indexing.js";
import { drainOutbox } from "../services/outbox.js";
import { setModuleImported } from "../services/workspaceModules.js";
import { buildBootstrap } from "../services/sync/index.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

/** One backfill pass embeds this many notes (indexing.ts BACKFILL_BATCH); the tests below assert the pass boundary. */
const BACKFILL_BATCH = 20;

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("semantic search indexing (DB)", () => {
  let WS = "";
  let owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  let other: ActorCtx = { id: "", name: "Other", role: "editor", type: "human" };
  const workspaces: string[] = [];

  const note = async (title: string, markdown = `${title} body`, extra: { nodeType?: string; deleted?: boolean; source?: string } = {}) =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${extra.deleted ? "now()" : "NULL"}) RETURNING id::text`,
      [WS, extra.nodeType ?? "content", extra.source ?? "manual", title, randomUUID(), markdown],
    )).rows[0]!.id;
  const embeddedIds = async () => (await q<{ node_id: string }>(
    `SELECT node_id::text FROM node_embeddings WHERE workspace_id = $1`, [WS])).rows.map((r) => r.node_id);
  const suggestionEdges = async () => (await q<{ source: string; target: string }>(
    `SELECT source_node_id::text AS source, target_node_id::text AS target FROM node_edges
      WHERE workspace_id = $1 AND edge_type = 'suggested_link' AND status = 'suggested'`, [WS])).rows;
  /** Run the outbox until the workspace has nothing pending (a batch files the next one). */
  async function drainAll(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const left = await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND status = 'pending'`, [WS]);
      if (left.rows[0]!.n === 0) return;
      await drainOutbox({ workspaceId: WS });
    }
    throw new Error("the outbox never settled");
  }
  const turnOn = () => setModuleImported({ actor: owner, workspaceId: WS, module: "semantic", imported: true });

  // Tests run in a random order: each has a workspace of its own, with the module not yet agreed to.
  beforeEach(async () => {
    registerShippedModules();
    const stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Indexing', $1) RETURNING id`, [`idx-${stamp}`])).rows[0]!.id;
    workspaces.push(WS);
    owner = await persistActor(WS, { id: `o-${stamp}`, name: "Owner", role: "admin", type: "human" });
    other = await persistActor(WS, { id: `x-${stamp}`, name: "Other", role: "editor", type: "human" });
    await setModulesOn(WS, []);
  });

  afterAll(async () => {
    await q(`DELETE FROM node_embeddings WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await q(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await pool.end();
  });

  it("turning it on embeds the notes that were already there, and only the ones worth embedding", async () => {
    const a = await note("Alpha"); const b = await note("Beta"); const c = await note("Gamma");
    const skipped = [
      await note("Trashed", "x", { deleted: true }),
      await note("Tag", "x", { nodeType: "class_tag" }),
      await note("System", "x", { source: "system" }),
      await note("", ""),
    ];
    expect(await embeddedIds()).toEqual([]);
    await turnOn();
    await drainAll();
    expect((await embeddedIds()).sort()).toEqual([a, b, c].sort());
    for (const id of skipped) expect(await embeddedIds()).not.toContain(id);
    expect(await indexProgress(WS, owner)).toEqual({ ready: 3, total: 3, working: false });
  });

  it("works through more notes than one batch, a batch at a time, and resumes after a stop", async () => {
    const ids: string[] = [];
    for (let i = 0; i < BACKFILL_BATCH + 5; i++) ids.push(await note(`Note ${i}`));
    await turnOn();
    await drainOutbox({ workspaceId: WS, limit: 1 }); // one attempt: one batch
    expect((await embeddedIds()).length).toBe(BACKFILL_BATCH);
    expect(await indexProgress(WS, owner)).toEqual({ ready: BACKFILL_BATCH, total: BACKFILL_BATCH + 5, working: true });
    // The chain is a pending row, so a restart picks up from what is stored.
    await drainAll();
    expect((await embeddedIds()).sort()).toEqual([...ids].sort());
  });

  it("turning it off stops the chain; nothing is embedded afterwards, and turning it on again finishes", async () => {
    for (let i = 0; i < BACKFILL_BATCH + 5; i++) await note(`Note ${i}`);
    await turnOn();
    await drainOutbox({ workspaceId: WS, limit: 1 });
    expect((await embeddedIds()).length).toBe(BACKFILL_BATCH);
    await setModuleImported({ actor: owner, workspaceId: WS, module: "semantic", imported: false });
    await drainAll();
    expect((await embeddedIds()).length).toBe(BACKFILL_BATCH); // the rest waits
    await turnOn();
    await drainAll();
    expect((await embeddedIds()).length).toBe(BACKFILL_BATCH + 5);
  });

  it("a server start resumes the indexing for a workspace that already had it on, and skips one that has it off", async () => {
    const a = await note("Alpha");
    await setModulesOn(WS, ["semantic"]); // on before indexing existed: nothing was ever filed
    expect(await embeddedIds()).toEqual([]);
    await resumeIndexing();
    await drainAll();
    expect(await embeddedIds()).toEqual([a]);
    // Nothing left to prepare: a second start files nothing; with the module off it files nothing either.
    await resumeIndexing();
    expect(await q(`SELECT 1 FROM outbox WHERE workspace_id = $1 AND status = 'pending'`, [WS])).toMatchObject({ rowCount: 0 });
    await q(`DELETE FROM node_embeddings WHERE workspace_id = $1`, [WS]);
    await setModulesOn(WS, []);
    await resumeIndexing();
    expect(await q(`SELECT 1 FROM outbox WHERE workspace_id = $1 AND status = 'pending'`, [WS])).toMatchObject({ rowCount: 0 });
  });

  it("files related-note suggestions on the server, and the owner's sync carries them", async () => {
    const a = await note("Alpha"); const b = await note("Beta"); const c = await note("Gamma");
    await turnOn();
    await drainAll();
    const edges = await suggestionEdges();
    // Every note is suggested the other two (the stub embedder has no meaning, only distances).
    for (const from of [a, b, c]) expect(edges.filter((e) => e.source === from).map((e) => e.target).sort()).toEqual([a, b, c].filter((x) => x !== from).sort());
    const boot = await buildBootstrap(owner, WS, { slimBodies: false });
    expect((boot.edges as Array<{ source_node_id: string; status: string }>).filter((e) => e.status === "suggested").length).toBe(6);
  });

  it("a later edit refreshes the note's suggestions without any client call", async () => {
    const a = await note("Alpha");
    await turnOn();
    await drainAll();
    expect(await suggestionEdges()).toEqual([]); // nothing else to suggest yet
    const b = await note("Beta");
    const { nodeContentCommitted } = await import("../services/nodeCommits.js");
    const { withTransaction } = await import("../db.js");
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: b, text: "Beta\n\nbody" }));
    await drainAll();
    expect(await suggestionEdges()).toEqual([{ source: b, target: a }]);
  });

  it("a note the reader cannot read is never suggested, returned by search, or counted", async () => {
    const shared = [await note("Alpha"), await note("Beta")];
    const secretSpace = await makeSpace(WS, `secret-${randomUUID()}`, [{ id: other.id, permission: "edit" }]);
    const secret = await note("Secret plan");
    await putInSpace(secret, secretSpace);
    await turnOn();
    await drainAll();
    // The owner cannot read the secret note: no suggestion points at it or from it, even though it is embedded.
    for (const e of await suggestionEdges()) { expect(e.source).not.toBe(secret); expect(e.target).not.toBe(secret); }
    expect(await indexProgress(WS, owner)).toMatchObject({ total: 2, ready: 2 });
    // The meaning search answers only with what the reader may read.
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    let who: ActorCtx = owner;
    app.use("*", async (c, next) => { c.set("actor", who); await next(); });
    app.onError(apiOnError);
    mountModules(app, [semanticModule]);
    appWorkspace = WS;
    try {
      const ask = async () => ((await (await app.request(`/api/semantic/search?q=${encodeURIComponent("Secret plan\n\nSecret plan body")}`)).json()) as Array<{ id: string }>).map((h) => h.id);
      expect(await ask()).not.toContain(secret);
      who = other;
      expect(await ask()).toContain(secret); // the one who can read it finds it (its own text is distance 0)
      // And off: nothing offered.
      await setModulesOn(WS, []);
      expect(await ask()).toEqual([]);
    } finally { appWorkspace = null; }
    expect(shared.length).toBe(2);
  });
});
