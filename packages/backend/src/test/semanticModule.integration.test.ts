// Semantic search is an optional library module, imported nowhere by default
// (user, 2026-10-18: 「語意搜尋要關」; modules/semantic).
//
//   • A new workspace's first library run does not import it.
//   • Not imported: a content change files no embed intent; the semanticSearch
//     and suggestLinks tools refuse with ModuleNotImportedError before any
//     query; its route refuses writes with 409 module_not_imported; the
//     harness's semantic hits are empty; a leftover embed intent settles as
//     done without embedding.
//   • Imported: a content change files the intent and it embeds.
//   • Migration 115 deletes dead + pending embed rows and nothing else.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

let appWorkspace: string | null = null;
vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  return { ...actual, getWorkspaceId: async () => appWorkspace ?? actual.getWorkspaceId() };
});
// Spy on the vector query: a refused tool must never reach it.
vi.mock("../services/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/embeddings.js")>();
  return {
    ...actual,
    semanticSearchNodes: vi.fn(actual.semanticSearchNodes),
    suggestLinksForNode: vi.fn(actual.suggestLinksForNode),
  };
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool, q, withTransaction } from "../db.js";
import { backfillModuleImports, mountModules } from "../modules/index.js";
import { semanticModule } from "../modules/semantic/index.js";
import { callTool } from "../services/agentTools/index.js";
import { drainOutbox } from "../services/outbox.js";
import { nodeContentCommitted } from "../services/nodeCommits.js";
import { semanticSearchNodes, suggestLinksForNode } from "../services/embeddings.js";
import { moduleRetrievalHits } from "../services/retrievalSources.js";
import { ModuleNotImportedError, workspaceModules } from "../services/workspaceModules.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const SQL = readFileSync(fileURLToPath(new URL("../../db/migrations/115_semantic_embed_cleanup.sql", import.meta.url)), "utf8");

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("semantic search module (DB)", () => {
  let stamp = "";
  let WS = "";
  let note = "";
  let actor: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  const workspaces: string[] = [];

  const setModules = (modules: string[]) =>
    setModulesOn(WS, modules);
  const embedRows = async () => (await q<{ status: string }>(
    `SELECT status FROM outbox WHERE workspace_id = $1 AND effect_kind = 'embed' ORDER BY id`, [WS],
  )).rows.map((r) => r.status);
  const embeddings = async () => (await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM node_embeddings WHERE workspace_id = $1`, [WS],
  )).rows[0]!.n;

  // A workspace of its own per test: module state, outbox rows and
  // embeddings never carry over from another test.
  beforeEach(async () => {
    registerShippedModules();
    stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Semantic', $1) RETURNING id`, [`sem-${stamp}`])).rows[0]!.id;
    workspaces.push(WS);
    actor = await persistActor(WS, { id: `sem-owner-${stamp}`, name: "Owner", role: "admin", type: "human" });
    note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'content', 'manual', 'Sem', $2, 'body') RETURNING id`, [WS, `sem-${stamp}`],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await q(`DELETE FROM node_embeddings WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await q(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    // The workspace and its actor stay: domain_events is append-only.
    await pool.end();
  });

  it("a new workspace has not agreed to semantic search yet, so it is off", async () => {
    await q(`UPDATE workspaces SET modules_off = '[]'::jsonb, modules_confirmed = '[]'::jsonb WHERE id = $1`, [WS]);
    await backfillModuleImports({ workspaceId: WS });
    expect(await workspaceModules(WS)).not.toContain("semantic");
  });

  it("not imported: a content change files no embed intent", async () => {
    await setModules([]);
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: note, text: "SEM-VECTOR" }));
    expect(await embedRows()).toEqual([]);
  });

  it("not imported: the agent tools refuse before querying", async () => {
    await setModules([]);
    vi.mocked(semanticSearchNodes).mockClear();
    vi.mocked(suggestLinksForNode).mockClear();
    await expect(callTool("semanticSearch", { query: "anything" }, { actor, workspaceId: WS }))
      .rejects.toBeInstanceOf(ModuleNotImportedError);
    await expect(callTool("suggestLinks", { nodeId: note }, { actor, workspaceId: WS }))
      .rejects.toBeInstanceOf(ModuleNotImportedError);
    expect(semanticSearchNodes).not.toHaveBeenCalled();
    expect(suggestLinksForNode).not.toHaveBeenCalled();
  });

  it("not imported: its route answers 409 module_not_imported", async () => {
    await setModules([]);
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    app.onError(apiOnError);
    mountModules(app, [semanticModule]);
    appWorkspace = WS;
    try {
      const res = await app.request(`/api/nodes/${note}/suggested-links`, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "module_not_imported", module: "semantic" });
      await setModules(["semantic"]);
      const ok = await app.request(`/api/nodes/${note}/suggested-links`, { method: "POST" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ suggestions: [] });
    } finally {
      appWorkspace = null;
    }
  });

  it("imported: a content change files the intent and it embeds", async () => {
    await setModules(["semantic"]);
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: note, text: "SEM-VECTOR" }));
    expect(await embedRows()).toEqual(["pending"]);
    await drainOutbox({ workspaceId: WS });
    expect(await embedRows()).toEqual(["done"]);
    expect(await embeddings()).toBe(1);
    expect((await callTool("semanticSearch", { query: "SEM-VECTOR" }, { actor, workspaceId: WS }) as { results: Array<{ id: string }> })
      .results.map((r) => r.id)).toContain(note);
    expect((await moduleRetrievalHits(WS, "SEM-VECTOR", { actor, limit: 6 })).map((h) => h.id)).toContain(note);
  });

  it("removed again: the harness gets no semantic hits and a leftover intent settles without embedding", async () => {
    await setModules(["semantic"]);
    // Imported and embedded once…
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: note, text: "SEM-VECTOR" }));
    await drainOutbox({ workspaceId: WS });
    expect(await embedRows()).toEqual(["done"]);
    // …then a change files an intent and the module is removed before it runs.
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: note, text: "SEM-VECTOR-2" }));
    await setModules([]);
    expect(await moduleRetrievalHits(WS, "SEM-VECTOR", { actor, limit: 6 })).toEqual([]);
    const hashBefore = (await q<{ content_hash: string }>(`SELECT content_hash FROM node_embeddings WHERE node_id = $1`, [note])).rows[0]!.content_hash;
    await drainOutbox({ workspaceId: WS });
    expect(await embedRows()).toEqual(["done", "done"]);
    // The stored embedding is kept, untouched (removing a module keeps its data).
    expect((await q<{ content_hash: string }>(`SELECT content_hash FROM node_embeddings WHERE node_id = $1`, [note])).rows[0]!.content_hash).toBe(hashBefore);
  });

  it("migration 115 deletes dead and pending embed rows, nothing else, repeatably", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    const rows: Array<[string, string]> = [
      ["embed", "dead"], ["embed", "pending"], ["embed", "done"],
      ["rss_fetch", "dead"], ["rss_fetch", "pending"], ["backup", "done"],
    ];
    for (const [kind, status] of rows) {
      await q(
        `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status)
         VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
        [WS, kind, `${kind}:${status}:${stamp}`, status],
      );
    }
    const left = async () => (await q<{ k: string }>(
      `SELECT effect_kind || ':' || status AS k FROM outbox WHERE workspace_id = $1 ORDER BY effect_kind, status`, [WS],
    )).rows.map((r) => r.k);
    await pool.query(SQL);
    expect(await left()).toEqual(["backup:done", "embed:done", "rss_fetch:dead", "rss_fetch:pending"]);
    await pool.query(SQL);
    expect(await left()).toEqual(["backup:done", "embed:done", "rss_fetch:dead", "rss_fetch:pending"]);
  });
});
