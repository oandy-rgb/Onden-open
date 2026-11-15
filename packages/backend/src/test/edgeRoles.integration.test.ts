// D74: what an edge is decides what may be done with it and where it goes.
// A derived edge — a `[[link]]` (origin wikilink) — is made from
// the note's text, so DELETE /api/edges/:id refuses it with 409 derived_edge
// (a retype is a delete and a create, so it is refused too); a drawn arrow or
// a machine suggestion may go. The published snapshot carries only active
// links of a published type (the frontend's lib/edgeRoles `publishes`).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, withTransaction } from "../db.js";
import edgesRouter from "../routes/edges.js";
import { syncWikilinkEdges } from "../services/wikilinkEdges.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/edges", edgesRouter);

describe.skipIf(!isTestDb)("edge roles on the server (D74)", () => {
  let admin: ActorCtx = { id: "d74-admin", name: "Admin", role: "admin", type: "human" };
  let viewer: ActorCtx = { id: "d74-viewer", name: "Viewer", role: "viewer", type: "human" };
  let a = "", b = "", c = "";
  const titleB = `Target ${randomUUID().slice(0, 8)}`;

  const mkNode = async (title: string, markdown = "") => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1, 'manual', 'content', $2, $3, $4) RETURNING id::text`,
    [WS, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 6)}`, markdown],
  )).rows[0]!.id;
  const insertEdge = async (source: string, target: string, edgeType: string, status: string, origin: string) => (await seedQ<{ id: string }>(
    `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`, [WS, source, target, edgeType, status, origin],
  )).rows[0]!.id;
  const wikilinkEdge = async () => (await q<{ id: string }>(
    `SELECT id::text FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [a, b],
  )).rows[0]?.id;
  const exists = async (id: string) => ((await q(`SELECT 1 FROM node_edges WHERE id = $1`, [id])).rowCount ?? 0) > 0;
  const del = (id: string, as: ActorCtx) => { currentActor = as; return app.request(`/api/edges/${id}`, { method: "DELETE" }); };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Edge roles', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(WS);
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);
    b = await mkNode(titleB);
    c = await mkNode("Other");
    a = await mkNode("Source", `see [[${titleB}]]`);
    await withTransaction(() => syncWikilinkEdges(WS, a, `see [[${titleB}]]`));
  });

  it("refuses to delete a [[link]]'s edge with 409 derived_edge; the row and the event log stay", async () => {
    const id = (await wikilinkEdge())!;
    expect(id).toBeTruthy();
    const events = async () => Number((await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND event_type = 'EDGE_DELETED'`, [WS])).rows[0]!.n);
    const before = await events();
    const res = await del(id, admin);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("derived_edge");
    expect(body.detail).toMatch(/Edit the note/);
    expect(await exists(id)).toBe(true);
    expect(await events()).toBe(before);
    // The note's next save keeps the same row (no churn, no second arrow).
    await withTransaction(() => syncWikilinkEdges(WS, a, `see [[${titleB}]]`));
    expect(await wikilinkEdge()).toBe(id);
  });

  it("a writer may delete a drawn arrow and dismiss a suggestion", async () => {
    currentActor = admin;
    const created = await app.request("/api/edges", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_node_id: c, target_node_id: b, edge_type: "supports" }),
    });
    expect(created.status).toBe(201);
    const drawn = await created.json() as { id: string; origin: string };
    expect(drawn.origin).toBe("manual");
    expect((await del(drawn.id, admin)).status).toBe(200);
    expect(await exists(drawn.id)).toBe(false);

    const suggestion = await insertEdge(c, a, "suggested_link", "suggested", "semantic");
    expect((await del(suggestion, admin)).status).toBe(200);
    expect(await exists(suggestion)).toBe(false);
  });

  it("someone who may not write the source gets 403, not a hint about the edge", async () => {
    const id = (await wikilinkEdge())!;
    expect((await del(id, viewer)).status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it("the published snapshot keeps only active links of a published type", async () => {
    for (const id of [a, b, c]) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
               VALUES ($1, $2, '_published', 'true', 'bool', 'explicit') ON CONFLICT (node_id, key) DO NOTHING`, [WS, id]);
    }
    const manual = await insertEdge(b, c, "knowledge_link", "active", "manual");
    const nav = await insertEdge(c, b, "nav_link", "active", "manual");
    const suggested = await insertEdge(b, a, "suggested_link", "suggested", "semantic");
    const rejected = await insertEdge(c, a, "knowledge_link", "rejected", "manual");
    const highlight = await insertEdge(b, a, "highlight_source", "active", "manual");
    const candidate = await buildCandidate(WS, { title: "Site" });
    const shipped = (candidate.payload.edges as Array<{ id: string }>).map((e) => e.id);
    expect(shipped).toEqual(expect.arrayContaining([(await wikilinkEdge())!, manual, nav]));
    for (const hidden of [suggested, rejected, highlight]) expect(shipped).not.toContain(hidden);
  });
});
