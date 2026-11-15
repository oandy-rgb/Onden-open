// A COHERENT real-world journey, not isolated assertions: the single most
// common thing people reach for a notes app to do (per the web's note-app
// surveys — Obsidian/Zettelkasten "research wiki", literature review, the
// gateway/MOC note connected by bidirectional links). We walk it end to end
// against the real spine + Postgres and assert the substrate did its job at
// every beat:
//
//   1. keep a reading list of sources
//   2. read a source → write an ATOMIC note that [[links]] back to it AND to
//      a gateway/MOC note  → wikilink EDGES materialize
//   3. the "create note from an unresolved [[link]]" path: a note written
//      before its target existed gets its backlink wired when the target is
//      created (relinkTarget)
//   4. the research wiki EMERGES: the gateway's backlinks gather every atomic
//      note that points at it
//   5. promote a finding into an action item → it lands on today's agenda
//   6. reorganize the gateway, then RESTORE — the researcher's safety net
//   7. soft-delete an atomic note and undelete it — the wiki survives a slip
//
// SAFETY: only runs against a *_test database (describe.skipIf); the normal
// host `vitest run` skips it, keeping the DB-free suite green.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

// A workspace of its own: the journey's [[links]] resolve by title and its
// agenda reads the workspace, so it runs beside no one else's notes — instead
// of wiping the shared default workspace as it used to. Routes read it via
// getWorkspaceId.
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);

const J = { "content-type": "application/json" };
const createNote = async (title: string, markdown = "") => {
  const res = await app.request("/api/nodes", { method: "POST", headers: J, body: JSON.stringify({ title, markdown }) });
  expect(res.status, `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; slug: string; title: string };
};
const editNote = (id: string, markdown: string, title: string) =>
  app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify({ title, markdown }) });
const addTask = (nodeId: string, body: unknown) =>
  app.request(`/api/nodes/${nodeId}/tasks`, { method: "POST", headers: J, body: JSON.stringify(body) });
const agenda = () => app.request("/api/tasks/agenda");
const versions = (id: string) => app.request(`/api/nodes/${id}/versions`);
const restoreVersion = (id: string, versionId: string) =>
  app.request(`/api/nodes/${id}/versions/${versionId}/restore`, { method: "POST", headers: J, body: "{}" });
const del = (id: string) => app.request(`/api/nodes/${id}`, { method: "DELETE" });
const undelete = (id: string) => app.request(`/api/nodes/${id}/undelete`, { method: "POST", headers: J, body: "{}" });

// Wikilink backlinks of a node = active wikilink edges that TARGET it, from a
// live source. This is exactly the "what links here" the gateway note shows.
async function backlinkSources(targetId: string): Promise<string[]> {
  const r = await q<{ source_node_id: string }>(
    `SELECT e.source_node_id
       FROM node_edges e JOIN content_nodes s ON s.id = e.source_node_id
      WHERE e.target_node_id = $1 AND e.origin = 'wikilink'
        AND e.status = 'active' AND s.deleted_at IS NULL`,
    [targetId],
  );
  return r.rows.map((x) => x.source_node_id).sort();
}
const today = async () =>
  (await q<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0]!.d;

describe.skipIf(!isTestDb)("research-wiki journey (literature review, end to end)", () => {
  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Research wiki', $1) RETURNING id`, [`rw-${randomUUID()}`],
    );
    workspaceId = ws.rows[0]!.id;
    const r = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Researcher', 'human') RETURNING id`,
      [workspaceId],
    );
    currentActor = { id: r.rows[0]!.id, name: "Researcher", role: "admin", type: "human" };
  });

  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [workspaceId]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
    await pool.end();
  });

  it("walks read → atomic-link → gateway-backlinks → task → restore → delete/undelete", async () => {
    // ── 1. A reading list of sources + the gateway (MOC) note ───────────────
    const paperA = await createNote("Paper: Attention Is All You Need", "seminal transformers paper");
    const paperB = await createNote("Paper: BERT", "bidirectional pretraining");
    const gateway = await createNote(
      "Transformers — Literature Review",
      "# Transformers\n\nMy gateway note. Findings collect here.",
    );

    // ── 2. Read paperA → an ATOMIC note linking back to it AND the gateway ───
    // Both targets already exist, so the edges materialize on this save.
    const atom1 = await createNote(
      "Self-attention scales context",
      "Key idea from [[Paper: Attention Is All You Need]].\nFiled under [[Transformers — Literature Review]].",
    );
    // The atomic note now has two outgoing wikilink edges.
    const atom1Edges = await q<{ target_node_id: string; edge_type: string; origin: string }>(
      `SELECT target_node_id, edge_type, origin FROM node_edges
        WHERE source_node_id = $1 AND origin = 'wikilink' AND status = 'active'`,
      [atom1.id],
    );
    expect(atom1Edges.rows.map((e) => e.target_node_id).sort()).toEqual([paperA.id, gateway.id].sort());
    expect(atom1Edges.rows.every((e) => e.edge_type === "knowledge_link")).toBe(true);

    // A second atomic note from paperB, also filed under the gateway.
    const atom2 = await createNote(
      "Bidirectional context beats left-to-right",
      "From [[Paper: BERT]]. See [[Transformers — Literature Review]].",
    );

    // ── 3. Create-from-unresolved-link: a note written BEFORE its target ────
    // exists gets its backlink wired when the target is created. atom3 links to
    // a note that does not exist yet; creating that note must back-wire the edge.
    const atom3 = await createNote(
      "Positional encoding is additive",
      "Depends on [[Sinusoidal Encoding]] (not written yet).",
    );
    const encoding = await createNote("Sinusoidal Encoding", "the sin/cos position trick");
    // relinkTarget ran on create → atom3 now links to `encoding`.
    expect(await backlinkSources(encoding.id)).toEqual([atom3.id]);

    // ── 4. The research wiki EMERGED: the gateway gathers its atomic notes ───
    expect(await backlinkSources(gateway.id)).toEqual([atom1.id, atom2.id].sort());

    // ── 5. Promote a finding into an action item due TODAY ──────────────────
    const due = await today();
    const taskRes = await addTask(gateway.id, { title: "Synthesize attention vs. recurrence", due_date: due });
    expect(taskRes.status).toBe(201);
    const ag = (await (await agenda()).json()) as { buckets: Record<string, Array<{ node_id: string; title: string }>> };
    const todayTitles = ag.buckets.today.map((t) => t.title);
    expect(todayTitles).toContain("Synthesize attention vs. recurrence");
    expect(ag.buckets.today.find((t) => t.title === "Synthesize attention vs. recurrence")!.node_id).toBe(gateway.id);

    // ── 6. Reorganize the gateway, then RESTORE the earlier body ────────────
    const reorganized = "# Transformers\n\nReorganized: attention, then pretraining, then encoding.";
    expect((await editNote(gateway.id, reorganized, gateway.title)).status).toBe(200);
    const vlist = (await (await versions(gateway.id)).json()) as Array<{ id: string }>;
    expect(vlist.length).toBeGreaterThanOrEqual(2); // at least the create + the edit
    const oldest = vlist[vlist.length - 1]!; // newest-first → last is the original create
    expect((await restoreVersion(gateway.id, oldest.id)).status).toBe(200);
    const restored = await q<{ markdown: string }>(
      `SELECT markdown FROM content_nodes WHERE id = $1`, [gateway.id],
    );
    expect(restored.rows[0]!.markdown).toContain("My gateway note");
    expect(restored.rows[0]!.markdown).not.toContain("Reorganized");

    // ── 7. Soft-delete an atomic note → it drops from the wiki; undelete ────
    expect((await del(atom2.id)).status).toBe(200);
    expect(await backlinkSources(gateway.id)).toEqual([atom1.id]); // atom2 gone from "what links here"
    expect((await undelete(atom2.id)).status).toBe(200);
    expect(await backlinkSources(gateway.id)).toEqual([atom1.id, atom2.id].sort()); // the wiki survived the slip
  });
});
