// COMPOSITION LAWS — orthogonality is proven at intersections, not corridors.
//
// Single-feature suites walk each capability down its own corridor; this file
// builds TEN differently-decorated node variants (each a distinct intersection
// class: space × publish × review × tasks × hidden × links × canvas × agent
// authorship × trash) and then runs UNIVERSAL law sweeps over them:
//
//   LAW 1 — read-policy totality: a viewer outside a node's space, and an
//           empty-read-scope bearer token, see the node on NO read surface.
//           Swept via the SURFACES table below (one row per list surface).
//   LAW 2 — restore round-trip: body PATCH + event inverse-restore returns the
//           body AND leaves every decoration untouched.
//   LAW 3 — soft-delete round-trip: while trashed a node is absent from every
//           list surface (even for the owner); undelete brings the FULL
//           decoration set back unchanged.
//
// Pinned-semantics tests (variants 3/7/9/10) document the CURRENT correct
// behaviour at incoherence-prone intersections, with reasoning, so a future
// change is a conscious decision rather than drift.
//
// Bugs this file caught at design time (fixed alongside it):
//   • GET /api/nodes/search applied NO read policy — a viewer could read
//     restricted titles + body snippets (routes/nodes.ts fix).
//   • GET /api/export (publish.ts legacy zip) zipped EVERY non-hidden node for
//     any authenticated viewer (readableNodeIdSet fix).
//   • /api/site's serve-time allowlist was weaker than the snapshot builder's:
//     restricting (schema tag) or hiding an ALREADY-published node did not pull
//     it from the live site (publishedNodeIds fix). Same gap in
//     /api/export-static's fallback, which served every non-hidden node.
//
// Mirrors src/test/reviewModule.integration.test.ts conventions (mini-app with
// an injectable actor — the routers' OWN read/write gates are what's under
// test, exactly the defense-in-depth layer behind the /api/mcp confinement).
// SAFETY: only runs against a *_test database; skips otherwise.
//
// Each run owns a workspace: unrelated fixtures must not fill capped day or
// review lists and hide this suite's positive controls on a persistent test DB.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, event } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import boardsRouter from "../routes/boards.js";
import versionsRouter from "../routes/versions.js";
import syncRouter from "../routes/sync.js";
import eventsRouter from "../routes/events.js";
import inboxRouter from "../routes/inbox.js";
import tagsRouter from "../routes/tags.js";
import exportRouter from "../routes/export.js";
import pointersRouter from "../routes/pointers.js";
import queryRouter from "../routes/query.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import dayRouter from "../routes/day.js";
import canvasesRouter from "../routes/canvases.js";
import publishRouter from "../modules/website/routes.js";
import mcpRouter from "../routes/mcp.js";
import reviewRouter from "../modules/review/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { adminOnlySpace, putInSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

registerShippedModules();

let compositionWorkspaceId = "";
// Route workspace selection only; all database operations and policies stay real.
vi.mock("../db.js", async original => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => compositionWorkspaceId,
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// ── Mini-app: the same mounting shape as src/index.ts, with an injectable
//    actor. tokenScope actors here exercise the per-endpoint read-scope layer
//    directly (in prod the /api/mcp confinement sits in front of it).
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/boards", boardsRouter);
app.route("/api/versions", versionsRouter);
app.route("/api/sync", syncRouter);
app.route("/api/events", eventsRouter);
app.route("/api/inbox", inboxRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/export", exportRouter);
app.route("/api/pointers", pointersRouter);
app.route("/api/query", queryRouter);
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);
app.route("/api/day", dayRouter);
app.route("/api/canvases", canvasesRouter);
app.route("/api/review", reviewRouter);
app.route("/api/mcp", mcpRouter);
app.route("/api", publishRouter); // /api/site, /api/publish, /api/export-static

const admin: ActorCtx = { id: "cl-admin", name: "CL Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "cl-viewer", name: "CL Viewer", role: "viewer", type: "human" };
// Delegated bearer token whose agent is in NO space (its membership is deleted
// in beforeAll): readable set = ∅ (global tag definitions aside).
const emptyToken: ActorCtx = {
  id: "cl-token", name: "CL empty-reach token", role: "editor", type: "agent",
  tokenScope: { tokenId: "cl-tok-empty", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

const J = { "Content-Type": "application/json" };
const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });
const put = (path: string, body: unknown = {}) =>
  app.request(path, { method: "PUT", headers: J, body: JSON.stringify(body) });
const patch = (path: string, body: unknown = {}) =>
  app.request(path, { method: "PATCH", headers: J, body: JSON.stringify(body) });
const del = (path: string) => app.request(path, { method: "DELETE" });
const getJson = async <T>(path: string): Promise<T> =>
  (await (await app.request(path)).json()) as T;

// ─────────────────────────────────────────────────────────────────────────────
// THE READ-SURFACE SWEEP TABLE — one row per node-listing read surface.
//
// ⚠ APPEND-POINT: when a NEW read surface ships (any endpoint that lists node
// data), ADD ONE ROW HERE — the law sweeps then prove it against all ten
// decorated variants for free. Rows marked list:true participate in the
// trash sweep too (id-addressed audit endpoints like /:id/versions stay
// reachable for trashed nodes by design — the trash UI previews through them).
//
// Public surfaces (/site page HTML, feed.xml, sitemap.xml, the site search
// panel) all derive from GET /api/site (frontend src/lib/siteFeed.ts), so the
// /api/site assertions in the variant tests cover their node SET; the
// rendered-output side is e2e/fullstack/composition.spec.ts braid 3.
// ─────────────────────────────────────────────────────────────────────────────

type Probe = { id: string; title: string; slug: string };

type SyncResp = {
  nodes: { upsert: Array<{ id: string }> };
  tasks: { upsert: Array<{ node_id: string }> };
  attributes: { upsert: Array<{ node_id: string }> };
  edges: { upsert: Array<{ source_node_id: string; target_node_id: string }> };
};
type LensResp = {
  buckets: {
    created: { items: Array<{ id: string }> };
    edited: { items: Array<{ id: string }> };
    agent: { items: Array<{ id: string }> };
    due: { items: Array<{ node_id: string }> };
  };
};
type AgendaResp = { buckets: Record<string, Array<{ node_id: string }>> };
type QueueResp = { cards: Array<{ node_id: string }> };

let PG_TODAY = ""; // server-side CURRENT_DATE — keeps date bucketing TZ-safe
let markTagId = ""; // schema-less label tag applied to every variant (query probe)
// The workspace's default shared space (publish on). Notes are created there:
// an API create without space_id lands in the creator's personal space.
let defaultSpaceId = "";
const MARK = () => `cl-mark-${stamp}`;
const stamp = Date.now();

/** since-cursor that puts the node's FIRST event inside /api/sync's window.
 *  Event ids can exceed 2^53 in a long-lived test database, so step back
 *  before the lossy number conversion (this suite owns its workspace, so the
 *  extra window holds only its own events). */
async function sinceFor(nodeId: string): Promise<number> {
  const r = await q<{ min: string | null }>(
    `SELECT MIN(id)::text AS min FROM domain_events WHERE target_id = $1`, [nodeId]);
  return r.rows[0]?.min ? Number(BigInt(r.rows[0].min) - 256n) : 0;
}

async function zipHasSlug(path: string, slug: string): Promise<boolean> {
  const res = await app.request(path);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  // Zip entry names are stored uncompressed in the local headers, so a plain
  // byte scan detects an entry; slugs are per-run-stamped → no false positives.
  return buf.includes(`${slug}.md`);
}

const SURFACES: Array<{ name: string; list: boolean; visible: (p: Probe) => Promise<boolean> }> = [
  { name: "GET /api/nodes/search", list: true, visible: async (p) => {
      const rows = await getJson<Array<{ id: string }>>(`/api/nodes/search?q=${encodeURIComponent(p.title)}`);
      return rows.some((r) => r.id === p.id);
  } },
  { name: "GET /api/events", list: true, visible: async (p) => {
      const r = await getJson<{ events: Array<{ target_id: string }> }>(
        `/api/events?target_type=node&target_id=${p.id}&limit=50`);
      return r.events.length > 0;
  } },
  { name: "GET /api/day/:today/lens (all buckets)", list: true, visible: async (p) => {
      const lens = await getJson<LensResp>(`/api/day/${PG_TODAY}/lens`);
      const b = lens.buckets;
      return b.created.items.some((x) => x.id === p.id)
        || b.edited.items.some((x) => x.id === p.id)
        || b.agent.items.some((x) => x.id === p.id)
        || b.due.items.some((x) => x.node_id === p.id);
  } },
  { name: "POST /api/query (by marker tag)", list: true, visible: async (p) => {
      const r = await (await post("/api/query", { tags: [MARK()], limit: 200 })).json() as { rows: Array<{ id: string }> };
      return r.rows.some((x) => x.id === p.id);
  } },
  { name: "GET /api/sync (nodes/tasks/attrs/edges incl. backlinks)", list: true, visible: async (p) => {
      const s = await getJson<SyncResp>(`/api/sync?since=${await sinceFor(p.id)}`);
      return s.nodes.upsert.some((n) => n.id === p.id)
        || s.tasks.upsert.some((t) => t.node_id === p.id)
        || s.attributes.upsert.some((a) => a.node_id === p.id)
        || s.edges.upsert.some((e) => e.source_node_id === p.id || e.target_node_id === p.id);
  } },
  { name: "GET /api/versions/recent", list: true, visible: async (p) => {
      const { rows } = await getJson<{ rows: Array<{ node_id: string }> }>(`/api/versions/recent?limit=200`);
      return rows.some((r) => r.node_id === p.id);
  } },
  { name: "GET /api/review/queue", list: true, visible: async (p) => {
      const r = await getJson<QueueResp>(`/api/review/queue`);
      return r.cards.some((c) => c.node_id === p.id);
  } },
  { name: "GET /api/tasks/agenda", list: true, visible: async (p) => {
      const r = await getJson<AgendaResp>(`/api/tasks/agenda`);
      return Object.values(r.buckets).flat().some((t) => t.node_id === p.id);
  } },
  { name: "GET /api/inbox", list: true, visible: async (p) => {
      const r = await getJson<{ events: Array<{ target_id: string }> }>(`/api/inbox?limit=500`);
      return r.events.some((e) => e.target_id === p.id);
  } },
  { name: "GET /api/export/markdown.zip", list: true, visible: (p) => zipHasSlug("/api/export/markdown.zip", p.title) },
  // id-addressed (not a list): stays readable for TRASHED nodes on purpose
  // (trash preview), so the delete sweep skips it; the policy sweep includes it.
  { name: "GET /api/nodes/:id/versions (single-node gate)", list: false, visible: async (p) =>
      (await app.request(`/api/nodes/${p.id}/versions`)).status === 200 },
];

/** LAW-1 helper: the probe is visible on NO surface for the CURRENT actor. */
async function expectAbsentEverywhere(p: Probe, who: string, opts: { listOnly?: boolean } = {}) {
  for (const s of SURFACES) {
    if (opts.listOnly && !s.list) continue;
    expect(await s.visible(p), `${s.name} leaks "${p.title}" to ${who}`).toBe(false);
  }
}

/** Positive control: the sweep isn't trivially green because surfaces are empty. */
async function expectVisibleOn(p: Probe, names: string[], who: string) {
  for (const s of SURFACES.filter((x) => names.includes(x.name))) {
    expect(await s.visible(p), `${s.name} should show "${p.title}" to ${who}`).toBe(true);
  }
}

// ── Decoration snapshot for the round-trip laws ─────────────────────────────
type Decorations = {
  tags: unknown[]; attrs: unknown[]; tasks: unknown[];
  edgesOut: unknown[]; edgesIn: unknown[]; pointers: unknown[]; positions: unknown[];
};
type AgendaTask = { id: string; node_id: string; title: string; status: string; due_date: string | null; recur: string | null };
/** Tasks via the FROZEN public agenda shape only — node_tasks internals are
 *  owned by the tasks-as-nodes migration track and must not be queried here.
 *  Open tasks only (agenda's contract); call as an actor who can read the node. */
async function agendaTasksOf(nodeId: string): Promise<AgendaTask[]> {
  const r = await getJson<{ buckets: Record<string, AgendaTask[]> }>(`/api/tasks/agenda`);
  return Object.values(r.buckets).flat()
    .filter((t) => t.node_id === nodeId)
    .map((t) => ({ id: t.id, node_id: t.node_id, title: t.title, status: t.status, due_date: t.due_date, recur: t.recur }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
async function decorations(id: string): Promise<Decorations> {
  const tags = await q(`SELECT tag_id FROM node_tags WHERE node_id = $1 ORDER BY tag_id`, [id]);
  const attrs = await q(`SELECT key, value FROM node_attributes WHERE node_id = $1 ORDER BY key`, [id]);
  const tasks = await agendaTasksOf(id);
  const edgesOut = await q(
    `SELECT target_node_id, edge_type, origin FROM node_edges WHERE source_node_id = $1 ORDER BY target_node_id, edge_type`, [id]);
  const edgesIn = await q(
    `SELECT source_node_id, edge_type, origin FROM node_edges WHERE target_node_id = $1 ORDER BY source_node_id, edge_type`, [id]);
  const pointers = await q(
    `SELECT parent_id, target_id FROM note_pointers WHERE parent_id = $1 OR target_id = $1 ORDER BY id`, [id]);
  const positions = await q(
    `SELECT surface, x, y FROM node_positions WHERE node_id = $1 ORDER BY surface`, [id]);
  return {
    tags: tags.rows, attrs: attrs.rows, tasks,
    edgesOut: edgesOut.rows, edgesIn: edgesIn.rows, pointers: pointers.rows, positions: positions.rows,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 400)); // post-commit dispatcher queue

// ── Shared builder + per-variant recipes ────────────────────────────────────
type V = Probe & { md: string };
async function mkNode(name: string, md: string, extra: Record<string, unknown> = {}): Promise<V> {
  const title = `cl ${name} ${stamp}`;
  // A note can no longer be created or made hidden (D104); a hidden variant
  // is a row hidden before that, written directly.
  const { hidden, ...fields } = extra;
  const res = await post("/api/nodes", { title, markdown: md, space_id: defaultSpaceId, ...fields });
  expect(res.status, `create "${title}"`).toBe(201);
  const n = (await res.json()) as { id: string; title: string; slug: string };
  if (hidden) await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [n.id]);
  await put(`/api/nodes/${n.id}/tags/${markTagId}`); // query-probe marker on every variant
  return { id: n.id, title: n.title, slug: n.slug, md };
}
async function mkLabelTag(name: string): Promise<string> {
  const res = await post("/api/tags/resolve-path", { path: name });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { leaf_id: string }).leaf_id;
}
/** A review card: the note makes itself one (its own function reference). */
const makeCard = async (nodeId: string) => { const r = await put(`/api/review/cards/${nodeId}`); expect(r.status, await r.clone().text()).toBe(200); };
const applyTag = (nodeId: string, tagId: string) => put(`/api/nodes/${nodeId}/tags/${tagId}`);
const putAttr = (nodeId: string, key: string, value: string) =>
  put(`/api/nodes/${nodeId}/attributes/${key}`, { value, value_type: "text" });
async function addTask(nodeId: string, title: string, due?: string, recur?: string): Promise<string> {
  const res = await post(`/api/nodes/${nodeId}/tasks`, { title, ...(due ? { due_date: due } : {}), ...(recur ? { recur } : {}) });
  expect(res.status, `task on ${nodeId}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
/** Explicit edge + its EDGE_CREATED event (the shape POST /api/edges in
 *  src/index.ts produces — that route lives on the root app, not a router). */
async function mkExplicitEdge(ws: string, source: string, target: string, edgeType: string): Promise<void> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
     VALUES ($1, $2, $3, $4, 'active', 'manual')
     ON CONFLICT (workspace_id, source_node_id, target_node_id, edge_type, origin)
     DO UPDATE SET status = 'active' RETURNING id`,
    [ws, source, target, edgeType]);
  await event(ws, "EDGE_CREATED", "edge", r.rows[0]!.id,
    { source_node_id: source, target_node_id: target, edge_type: edgeType }, "user", admin.id);
}
async function siteNodeIds(): Promise<Set<string>> {
  const s = await getJson<{ payload?: { nodes?: Array<{ id: string }> } }>(`/api/site`);
  return new Set((s.payload?.nodes ?? []).map((n) => n.id));
}
async function gradeOnce(nodeId: string): Promise<void> {
  const res = await post(`/api/review/${nodeId}/grade`, { rating: 3 });
  expect(res.status, `grade ${nodeId}`).toBe(200);
}
async function latestEventId(nodeId: string, type: string): Promise<string> {
  const r = await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = $2 ORDER BY domain_events.id DESC LIMIT 1`,
    [nodeId, type]);
  expect(r.rows[0], `${type} event for ${nodeId}`).toBeTruthy();
  return r.rows[0]!.id;
}
async function markdownOf(id: string): Promise<string> {
  const r = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id]);
  return r.rows[0]?.markdown ?? "";
}

describe.skipIf(!isTestDb)("composition laws (DB)", () => {
  let WS = "";
  let secretSpaceId = ""; // admin-only space — where restricted variants live
  let canvasA = "";
  let canvasB = "";
  let TOMORROW = "";

  // The ten variants (v2 keeps sub-fixtures local to its test).
  let v1: V;   // KITCHEN SINK
  let v2a: V;  // RESTRICTED×PUBLISHED (moved into the private space BEFORE publish)
  let v3: V;   // HIDDEN×CAPABLE
  let v4: V;   // TRASH RESIDENT
  let v5: V;   // RSS GRADUATE
  let v6: V;   // RECURRING CARRIER
  let v7: V;   // META-DECORATED (a class_tag node as the carrier)
  let v8: V;   // LINK HUB
  let v9: V;   // DAY NODE DECORATED
  let v10: V;  // AGENT FOUNDATION
  let v1TargetTitle = "";
  let v6TaskId = "";
  let v8BlockId = "";
  let v8NodeB: V;
  let v10OwnTagId = "";
  let v10WorkTagId = "";

  const allVariants = (): Array<[string, V]> => [
    ["v1 kitchen sink", v1], ["v2 restricted×published", v2a], ["v3 hidden×capable", v3],
    ["v4 trash resident", v4], ["v5 rss graduate", v5], ["v6 recurring carrier", v6],
    ["v7 meta-decorated", v7], ["v8 link hub", v8], ["v9 day node", v9], ["v10 agent foundation", v10],
  ];

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug)
      VALUES ('Composition laws',$1) RETURNING id`, [`cl-workspace-${stamp}`])).rows[0].id;
    await publishDefaultSpace(WS);
    compositionWorkspaceId = WS;
    await setModulesOn(WS, null);
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    Object.assign(emptyToken, await persistActor(WS, emptyToken));
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [emptyToken.id]);
    defaultSpaceId = (await q<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id=$1 AND is_default`, [WS])).rows[0]!.id;
    const today = await q<{ d: string; t: string }>(`SELECT CURRENT_DATE::text AS d, (CURRENT_DATE + 1)::text AS t`);
    PG_TODAY = today.rows[0]!.d;
    TOMORROW = today.rows[0]!.t;

    currentActor = admin;
    markTagId = await mkLabelTag(MARK());
    // Publish is off in a makeSpace space, and only the admin is a member.
    secretSpaceId = await adminOnlySpace(WS, `cl-secret-${stamp}`, [admin.id]);

    canvasA = ((await (await post("/api/canvases", { title: `cl canvas A ${stamp}` })).json()) as { id: string }).id;
    canvasB = ((await (await post("/api/canvases", { title: `cl canvas B ${stamp}` })).json()) as { id: string }).id;

    // ── V1 KITCHEN SINK: every decoration class on one node ────────────────
    const v1Target = await mkNode("kitchen target", "the linked-to note");
    v1TargetTitle = v1Target.title;
    v1 = await mkNode("kitchen sink", `# sink\n\nstatus:: cooking\n\nlinks to [[${v1Target.title}]]\n`);
    await addTask(v1.id, `cl sink task ${stamp}`, PG_TODAY);
    await makeCard(v1.id);
    await gradeOnce(v1.id);
    // Its link target moves with it: [[title]] resolves within the note's
    // space, so a target left in 共用 would lose the edge at v1's next save
    // (putInSpace is a raw move that skips moveToSpace's relink).
    await putInSpace(v1.id, secretSpaceId);
    await putInSpace(v1Target.id, secretSpaceId);
    await putAttr(v1.id, "_published", "true"); // PUBLISHED_KEY is the one legal _-key
    await putAttr(v1.id, "ink_data", JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } }));
    await patch(`/api/boards/${canvasA}`, { cards: { upsert: [{ nodeId: v1.id, x: 10, y: 20 }] } }); // board placements go through /api/boards (W23)
    await post("/api/pointers", { target_id: v1.id, parent_id: v1Target.id });

    // ── V2a RESTRICTED×PUBLISHED (tag first; publish happens in its test) ──
    v2a = await mkNode("restricted pub a", `TOPSECRET-A-${stamp} body`);
    await putInSpace(v2a.id, secretSpaceId);
    await putAttr(v2a.id, "_published", "true");

    // ── V3 HIDDEN×CAPABLE ───────────────────────────────────────────────────
    v3 = await mkNode("hidden capable", "hidden but capable", { hidden: true });
    // A hidden note cannot be made a card through the route (it is not a visible note); the reference is written directly.
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [WS, v3.id]);
    await addTask(v3.id, `cl hidden task ${stamp}`, PG_TODAY);

    // ── V4 TRASH RESIDENT (published + review state; deleted in its test) ──
    v4 = await mkNode("trash resident", "published then trashed");
    await putAttr(v4.id, "_published", "true");
    await makeCard(v4.id);
    await gradeOnce(v4.id);

    // ── V5 RSS GRADUATE: seeded _rss_* attrs + hidden birth, then promoted ──
    v5 = await mkNode("rss graduate", "an article worth keeping", { hidden: true, source_type: "rss" });
    // _-prefixed keys are module-reserved (the attribute route rejects them),
    // so the rss fixture state is seeded at the substrate level, exactly the
    // rows modules/rss/fetch.ts writes.
    for (const [k, val] of [["_rss_item_url", `https://example.test/cl/${stamp}`], ["_rss_published_at", new Date().toISOString()], ["_rss_read", "true"]] as const) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1,$2,$3,$4,'derived')
               ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value`, [WS, v5.id, k, val]);
    }
    expect((await post(`/api/nodes/${v5.id}/promote`)).status).toBe(200); // 留 keep → hidden=false
    await makeCard(v5.id);
    await putAttr(v5.id, "_published", "true");
    await addTask(v5.id, `cl graduate follow-up ${stamp}`, PG_TODAY);

    // ── V6 RECURRING CARRIER ────────────────────────────────────────────────
    v6 = await mkNode("recurring carrier", "note with a recurring duty");
    await putInSpace(v6.id, secretSpaceId);
    v6TaskId = await addTask(v6.id, `cl water plants ${stamp}`, PG_TODAY, "1d");

    // ── V7 META-DECORATED: a class_tag node ITSELF carries #review + a task ─
    const metaTagId = await mkLabelTag(`cl-meta-${stamp}`);
    const meta = await q<{ id: string; title: string; slug: string }>(
      `SELECT id, title, slug FROM content_nodes WHERE id = $1`, [metaTagId]);
    v7 = { ...meta.rows[0]!, md: "" };
    await applyTag(v7.id, markTagId);
    // A tag node is no content note, so the route refuses it; the reference is written directly (review must still refuse to grade it).
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [WS, v7.id]);
    await addTask(v7.id, `cl meta task ${stamp}`, PG_TODAY);

    // ── V8 LINK HUB ─────────────────────────────────────────────────────────
    v8BlockId = `clb${stamp}`;
    v8NodeB = await mkNode("linkB", "outbound target");
    v8 = await mkNode("hub", `points out to [[cl linkB ${stamp}]]\n\nan anchored para ^${v8BlockId}\n`);
    await mkNode("linkA", `points into [[cl hub ${stamp}]]`);             // in-edge via wikilink
    const v8C = await mkNode("linkC", `block-ref [[cl hub ${stamp}#^${v8BlockId}]]`);
    await mkExplicitEdge(WS, v8C.id, v8.id, "block_ref");                  // explicit typed edge (rides /api/sync)
    const sketch = await mkNode("sketch scene", "");
    await putAttr(sketch.id, "sketch_data", "{}");                         // what makes a node a sketch
    await post("/api/pointers", { target_id: v8.id, parent_id: sketch.id }); // embedded in the sketch's scene
    await patch(`/api/boards/${canvasA}`, { cards: { upsert: [{ nodeId: v8.id, x: 1, y: 1 }] } });
    await patch(`/api/boards/${canvasB}`, { cards: { upsert: [{ nodeId: v8.id, x: 2, y: 2 }] } });

    // ── V9 DAY NODE DECORATED: today's day node is itself a decorated note ──
    const dayRes = await post("/api/nodes", { title: PG_TODAY, markdown: "## my day", space_id: defaultSpaceId });
    expect(dayRes.status).toBe(201);
    const day = (await dayRes.json()) as { id: string; title: string; slug: string };
    v9 = { id: day.id, title: day.title, slug: day.slug, md: "## my day" };
    await put(`/api/nodes/${v9.id}/tags/${markTagId}`);
    await makeCard(v9.id);
    await addTask(v9.id, `cl day duty ${stamp}`, PG_TODAY);
    await putAttr(v9.id, "_published", "true");

    // ── V10 AGENT FOUNDATION: agent-authored node + owner decorations ──────
    v10WorkTagId = await mkLabelTag(`cl-work-${stamp}`);
    v10OwnTagId = await mkLabelTag(`cl-own-${stamp}`);
    const agentScoped = await persistActor(WS, {
      id: "cl-agent", name: "CL Agent", role: "editor", type: "agent",
      tokenScope: { tokenId: `cl-tok-${stamp}`, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    currentActor = agentScoped;
    const created = await post("/api/mcp/tools/createNode", {
      args: { title: `cl agent seed ${stamp}`, markdown: "agent-authored body", tag_id: v10WorkTagId },
    });
    expect(created.status, "agent createNode").toBe(200);
    const tool = (await created.json()) as { result: { id: string; slug: string; title: string } };
    v10 = { id: tool.result.id, title: tool.result.title, slug: tool.result.slug, md: "agent-authored body" };
    currentActor = admin; // the OWNER decorates the agent's node
    await put(`/api/nodes/${v10.id}/tags/${markTagId}`);
    await applyTag(v10.id, v10OwnTagId);
    await putAttr(v10.id, "verdict", "keep");
    await addTask(v10.id, `cl follow up on agent note ${stamp}`, PG_TODAY);

    await settle(); // let post-commit dispatcher queues drain before assertions
  });

  afterAll(async () => {
    if (!WS) return;
    await settle();
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [WS]);
    await deleteWorkspaceActors(WS);
  });

  // ── Per-variant recipe pins ────────────────────────────────────────────────

  it("v1 KITCHEN SINK: every decoration class actually landed", async () => {
    currentActor = admin;
    const d = await decorations(v1.id);
    expect(d.tags.length).toBe(1); // the mark (review is the note's own reference now; the secret is its space now)
    const attrs = await q<{ key: string; value: string }>(
      `SELECT key, value FROM node_attributes WHERE node_id = $1`, [v1.id]);
    const byKey = new Map(attrs.rows.map((a) => [a.key, a.value]));
    expect(byKey.get("status"), "inline `status:: cooking` derived in-tx on create").toBe("cooking");
    expect(byKey.get("_published")).toBe("true");
    expect(byKey.has("ink_data")).toBe(true);
    const review = await q<{ state: string }>(`SELECT state FROM review_states WHERE node_id = $1`, [v1.id]);
    expect(JSON.parse(review.rows[0]?.state ?? "{}").reps, "graded once (personal progress)").toBe(1);
    expect(d.tasks.length).toBe(1);
    expect(d.edgesOut.length, "wikilink edge").toBe(1);
    expect(d.pointers.length).toBe(1);
    expect(d.positions.length).toBe(1);
    const canvas = await getJson<{ data: { nodes: Array<{ nodeId: string }> } }>(`/api/canvases/${canvasA}`);
    expect(canvas.data.nodes.some((n) => n.nodeId === v1.id), "canvas membership").toBe(true);
    // Owner-side positive control — the policy sweep below isn't vacuous.
    await expectVisibleOn(v1, [
      "GET /api/nodes/search", "GET /api/events", "POST /api/query (by marker tag)",
      "GET /api/sync (nodes/tasks/attrs/edges incl. backlinks)", "GET /api/versions/recent",
      "GET /api/tasks/agenda", "GET /api/export/markdown.zip",
      "GET /api/day/:today/lens (all buckets)",
    ], "admin");
  });

  it("v2 RESTRICTED×PUBLISHED: the restricted node never reaches the public site, in EITHER order", async () => {
    currentActor = admin;
    // (a) restrict-then-publish: a note in a space whose publish switch is off
    // is never publishable, so an explicit _published opt-in on it is inert.
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v2a.id), "/api/site must not serve a node of a publish-off space").toBe(false);
    expect(await zipHasSlug("/api/export-static", v2a.slug), "/api/export-static must not zip a node of a publish-off space").toBe(false);

    // (b) publish-then-restrict: the serve-time allowlist must be as strong as
    // the build predicate. Before the publishedNodeIds fix the stale snapshot
    // row kept being served after the node was restricted (HIGH leak — a
    // restriction triggers no republish).
    const v2b = await mkNode("restricted pub b", `TOPSECRET-B-${stamp} body`);
    await putAttr(v2b.id, "_published", "true");
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v2b.id), "published → served").toBe(true);
    await putInSpace(v2b.id, secretSpaceId);
    expect((await siteNodeIds()).has(v2b.id), "restricting a published node pulls it from /api/site on the next read").toBe(false);
    expect(await zipHasSlug("/api/export-static", v2b.slug), "…and from the static export").toBe(false);

    // (c) publish-then-hide: same law for the hidden flag. A note can no
    // longer be hidden (D104: 400); a row hidden before that is pulled.
    const v2c = await mkNode("restricted pub c", `TOPSECRET-C-${stamp} body`);
    await putAttr(v2c.id, "_published", "true");
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v2c.id)).toBe(true);
    expect((await patch(`/api/nodes/${v2c.id}`, { hidden: true })).status).toBe(400);
    expect((await siteNodeIds()).has(v2c.id), "a refused hide changes nothing").toBe(true);
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [v2c.id]);
    expect((await siteNodeIds()).has(v2c.id), "a hidden published node is pulled from /api/site").toBe(false);
    expect((await patch(`/api/nodes/${v2c.id}`, { hidden: false })).status).toBe(200);
    expect((await siteNodeIds()).has(v2c.id), "un-hiding restores it (snapshot row still present)").toBe(true);
    // feed.xml / sitemap.xml / site-search derive from this same /api/site
    // payload — rendered-output coverage lives in e2e composition.spec braid 3.
  });

  it("v3 HIDDEN×CAPABLE: pinned stance of every capability surface on a hidden node", async () => {
    currentActor = admin;
    // PINNED SEMANTICS (and the one incoherence, flagged): `hidden` means
    // "not yet promoted to a first-class note" (RSS arrivals). The note-list
    // surfaces that present NODES filter it (review queue, day-lens
    // created/edited/agent, query, publish) — but its TASKS are first-class
    // actionable rows, so task surfaces (agenda, day-lens due) DO show them,
    // and search/sync currently DO list hidden nodes (the reader deep-links
    // through search; sync must carry hidden rows for the reader UI at all).
    // FLAG: search showing hidden nodes while query hides them is a real
    // surface disagreement — pinned here so changing either is deliberate.
    const queue = await getJson<QueueResp>(`/api/review/queue`);
    expect(queue.cards.some((c) => c.node_id === v3.id), "review queue hides hidden nodes").toBe(false);
    const lens = await getJson<LensResp>(`/api/day/${PG_TODAY}/lens`);
    expect(lens.buckets.created.items.some((x) => x.id === v3.id), "lens.created hides hidden nodes").toBe(false);
    expect(lens.buckets.due.items.some((x) => x.node_id === v3.id), "lens.due DOES list a hidden node's task (pinned)").toBe(true);
    const agenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(Object.values(agenda.buckets).flat().some((t) => t.node_id === v3.id), "agenda DOES list a hidden node's task (pinned)").toBe(true);
    const search = await getJson<Array<{ id: string }>>(`/api/nodes/search?q=${encodeURIComponent(v3.title)}`);
    expect(search.some((r) => r.id === v3.id), "search DOES list hidden nodes (pinned + flagged)").toBe(true);
    const qr = (await (await post("/api/query", { tags: [MARK()], limit: 200 })).json()) as { rows: Array<{ id: string }> };
    expect(qr.rows.some((r) => r.id === v3.id), "query blocks hide hidden nodes").toBe(false);
    // The unrestricted hidden node is readable by space — a viewer sees the
    // same stances (hidden ≠ access control; spaces are access control).
    currentActor = viewer;
    const vAgenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(Object.values(vAgenda.buckets).flat().some((t) => t.node_id === v3.id)).toBe(true);
    currentActor = admin;
  });

  it("v4 TRASH RESIDENT: while deleted it is absent from every surface incl. /api/site; restore brings all decorations back, and the site waits for the next publish", async () => {
    currentActor = admin;
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v4.id), "published pre-trash").toBe(true);
    const before = await decorations(v4.id);
    expect((await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [v4.id])).rowCount, "graded before trash").toBe(1);

    expect((await del(`/api/nodes/${v4.id}`)).status).toBe(200);
    await expectAbsentEverywhere(v4, "admin (node trashed)", { listOnly: true });
    expect((await siteNodeIds()).has(v4.id), "trash pulls a published node from /api/site").toBe(false);
    expect(await zipHasSlug("/api/export-static", v4.slug)).toBe(false);

    expect((await post(`/api/nodes/${v4.id}/undelete`)).status).toBe(200);
    expect(await decorations(v4.id), "undelete restores the FULL decoration set").toEqual(before);
    // Taken-down content does not come back by itself (owner 2026-11-14): the restored note is back in the
    // workspace with everything it had, and on the site only with the next publish.
    expect((await siteNodeIds()).has(v4.id), "undelete does not re-serve the old snapshot's copy").toBe(false);
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v4.id), "the next publish brings it back").toBe(true);
  });

  it("v5 RSS GRADUATE: the promoted article keeps its full end-state and is visible to a viewer (positive control)", async () => {
    currentActor = admin;
    const hidden = await q<{ hidden: boolean }>(`SELECT hidden FROM content_nodes WHERE id = $1`, [v5.id]);
    expect(hidden.rows[0]!.hidden, "promote un-hid it").toBe(false);
    const attrs = await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1`, [v5.id]);
    expect(attrs.rows.map((a) => a.key)).toEqual(expect.arrayContaining(["_rss_item_url", "_rss_read", "_published"]));
    const queue = await getJson<QueueResp>(`/api/review/queue`);
    expect(queue.cards.some((c) => c.node_id === v5.id), "fresh #review card is due").toBe(true);
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v5.id), "label-tagged (schema-less) graduate IS publishable").toBe(true);
    // The unrestricted variant is the sweep's positive control: a plain
    // viewer sees it on the full surface table (proves LAW 1 isn't vacuous).
    currentActor = viewer;
    await expectVisibleOn(v5, [
      "GET /api/nodes/search", "GET /api/events", "GET /api/day/:today/lens (all buckets)",
      "POST /api/query (by marker tag)", "GET /api/sync (nodes/tasks/attrs/edges incl. backlinks)",
      "GET /api/versions/recent", "GET /api/review/queue", "GET /api/tasks/agenda",
      "GET /api/export/markdown.zip",
      "GET /api/nodes/:id/versions (single-node gate)",
    ], "viewer");
    currentActor = admin;
  });

  it("v6 RECURRING CARRIER: completing mints the next occurrence with a CONSISTENT policy stance (pinned: same node ⇒ same policy)", async () => {
    currentActor = admin;
    const res = await patch(`/api/tasks/${v6TaskId}`, { status: "done" });
    expect(res.status).toBe(200);
    // Tasks via the frozen public agenda shape only (node_tasks internals are
    // the tasks-as-nodes track's): the completed occurrence left the agenda,
    // the minted one arrived — todo, due tomorrow, recur carried forward.
    const mine = await agendaTasksOf(v6.id);
    const minted = mine.find((t) => t.id !== v6TaskId);
    expect(minted, "break-or-make minted the next occurrence").toBeTruthy();
    expect(mine.some((t) => t.id === v6TaskId), "the completed occurrence is no longer open").toBe(false);
    expect(minted!.status).toBe("todo");
    expect(minted!.due_date).toBe(TOMORROW);
    expect(minted!.recur).toBe("1d");
    // PINNED: the occurrence is a child of the SAME node, so it lives in the
    // note's private space by construction — admin sees it bucketed,
    // a viewer sees neither occurrence (swept fully in LAW 1).
    const agenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(agenda.buckets.upcoming?.some((t) => t.node_id === v6.id), "minted occurrence in admin agenda (upcoming)").toBe(true);
    currentActor = viewer;
    const vAgenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(Object.values(vAgenda.buckets).flat().some((t) => t.node_id === v6.id), "viewer sees NO occurrence of the restricted carrier").toBe(false);
    currentActor = admin;
  });

  it("v7 META-DECORATED: a #review-tagged class_tag node — queue and day lens are content-only; search lists it", async () => {
    currentActor = admin;
    // PINNED: the review queue is content-nodes-only (modules/review/service
    // loadEnrolledCards: node_type='content'), so a tag node never becomes a card…
    const queue = await getJson<QueueResp>(`/api/review/queue`);
    expect(queue.cards.some((c) => c.node_id === v7.id), "review queue excludes tag nodes").toBe(false);
    // The module contract is content-only at both the queue and write boundary.
    expect((await post(`/api/review/${v7.id}/grade`, { rating: 3 })).status).toBe(409);
    const lens = await getJson<LensResp>(`/api/day/${PG_TODAY}/lens`);
    // 2026-10-12: a tag is not a note made that day, so the day lens leaves
    // class_tag nodes out (routes/day.ts LENS_NODE_FILTER); search still lists it.
    expect(lens.buckets.created.items.some((x) => x.id === v7.id), "lens.created leaves out class_tag nodes").toBe(false);
    // Search returns tag nodes too (node_type rides the row for the UI).
    const search = await getJson<Array<{ id: string; node_type: string }>>(`/api/nodes/search?q=${encodeURIComponent(v7.title)}`);
    const hit = search.find((r) => r.id === v7.id);
    expect(hit, "search lists the tag node").toBeTruthy();
    expect(hit!.node_type).toBe("class_tag");
    // And its task is an ordinary agenda row.
    const agenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(Object.values(agenda.buckets).flat().some((t) => t.node_id === v7.id), "tag node's task is bucketed").toBe(true);
  });

  it("v8 LINK HUB: delete+restore ripples edges/pointers/positions/block-refs with no orphans", async () => {
    currentActor = admin;
    const before = await decorations(v8.id);
    expect((before.edgesOut as unknown[]).length, "1 wikilink out-edge").toBe(1);
    // Two wikilink in-edges (linkA's plain [[hub]] + linkC's [[hub#^block]] — the
    // block anchor is stripped during resolution, 4ec347e) + the explicit block_ref edge.
    expect((before.edgesIn as unknown[]).length, "2 wikilink in-edges + explicit block_ref edge").toBe(3);
    expect((before.pointers as unknown[]).length, "embedded in the sketch scene").toBe(1);
    expect((before.positions as unknown[]).length, "positioned on TWO canvases").toBe(2);

    expect((await del(`/api/nodes/${v8.id}`)).status).toBe(200);
    // Ripple while trashed: the explicit edge drops out of /api/sync (an
    // endpoint of the pair is unreadable); backlinks of the still-live
    // neighbour stay consistent (no dangling hub reference). A [[hub#^id]]
    // block ref resolves from the hub's own text (D59), so it goes with it.
    const s = await getJson<SyncResp>(`/api/sync?since=${await sinceFor(v8.id)}`);
    expect(s.edges.upsert.some((e) => e.source_node_id === v8.id || e.target_node_id === v8.id),
      "sync carries no edge touching the trashed hub").toBe(false);
    const orphanCheck = await decorations(v8.id);
    expect(orphanCheck, "soft delete keeps the substrate intact (rows hidden, not orphaned)").toEqual(before);

    expect((await post(`/api/nodes/${v8.id}/undelete`)).status).toBe(200);
    expect(await decorations(v8.id), "undelete restores the identical link substrate").toEqual(before);
    expect((await getJson<SyncResp>(`/api/sync?since=${await sinceFor(v8.id)}`)).edges.upsert
      .some((e) => e.target_node_id === v8.id), "explicit edge re-listed after undelete").toBe(true);
    // Backlink consistency for the linked neighbour: hub→B edge intact.
    const bIn = await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [v8.id, v8NodeB.id]);
    expect(bIn.rowCount).toBe(1);
  });

  it("v9 DAY NODE DECORATED: today's lens renders ON it without self-inclusion; its decorations behave like any note's", async () => {
    currentActor = admin;
    const lens = await getJson<LensResp>(`/api/day/${PG_TODAY}/lens`);
    // PINNED: the day node never lists in its own created/edited/agent buckets
    // (NOT_THE_DAY_NODE) — no recursion. Its own task DOES appear in the due
    // bucket: a task due today belongs on today's lens regardless of which
    // note hosts it (pinned as correct; the exclusion is about node identity,
    // not about work scheduled on the day).
    expect(lens.buckets.created.items.some((x) => x.id === v9.id), "no self-inclusion in created").toBe(false);
    expect(lens.buckets.edited.items.some((x) => x.id === v9.id), "no self-inclusion in edited").toBe(false);
    expect(lens.buckets.due.items.some((x) => x.node_id === v9.id), "its own task lists in due (pinned)").toBe(true);
    // Decorations are ordinary: review card due, published on the site.
    const queue = await getJson<QueueResp>(`/api/review/queue`);
    expect(queue.cards.some((c) => c.node_id === v9.id), "day node is a due review card").toBe(true);
    expect((await publishWithPreview(post, {})).status).toBe(201);
    expect((await siteNodeIds()).has(v9.id), "published day node serves on /api/site").toBe(true);
  });

  it("v10 AGENT FOUNDATION: rejecting the agent's NODE_CREATED soft-deletes the node; owner decorations survive invisibly and return on undelete (pinned)", async () => {
    currentActor = admin;
    // The governance queue shows the agent's create (events ride actor_type).
    const inbox = await getJson<{ events: Array<{ id: string; event_type: string; target_id: string }> }>(`/api/inbox?limit=500`);
    const createEv = inbox.events.find((e) => e.target_id === v10.id && e.event_type === "NODE_CREATED");
    expect(createEv, "agent NODE_CREATED is in the inbox").toBeTruthy();

    const before = await decorations(v10.id);
    expect((before.tags as unknown[]).length, "agent work-tag + owner mark + owner own-tag").toBe(3);

    const rejected = await post(`/api/inbox/${createEv!.id}/reject`);
    expect(rejected.status, "reject runs the inverse-undo").toBe(200);

    // PINNED SEMANTICS: reject of NODE_CREATED = SOFT delete (inverse_op
    // node.deleted), with the agent's own triggered chain (its tag apply)
    // cascade-reverted. The owner's decorations are NOT events in the agent's
    // chain, so their rows survive — attached to a trashed node: invisible on
    // every read surface (not orphan-leaked), recoverable by undelete. This is
    // the trash substrate, not data loss.
    const row = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [v10.id]);
    expect(row.rows[0]!.deleted_at, "node is soft-deleted").not.toBeNull();
    const tagsNow = await q<{ tag_id: string }>(`SELECT tag_id FROM node_tags WHERE node_id = $1`, [v10.id]);
    expect(tagsNow.rows.some((t) => t.tag_id === v10WorkTagId), "the agent's own tag apply was cascade-reverted").toBe(false);
    expect(tagsNow.rows.some((t) => t.tag_id === v10OwnTagId), "the owner's tag row survives in the substrate").toBe(true);
    const attrsNow = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'verdict'`, [v10.id]);
    expect(attrsNow.rowCount, "owner attr row survives").toBe(1);
    await expectAbsentEverywhere(v10, "admin (rejected agent node)", { listOnly: true });

    // Undelete = the owner changing their mind: node + owner decorations live again.
    expect((await post(`/api/nodes/${v10.id}/undelete`)).status).toBe(200);
    const after = await decorations(v10.id);
    expect((after.tags as unknown[]).length, "work-tag stays reverted; owner decorations are back").toBe(2);
    expect((after.tasks as unknown[]).length).toBe(1);
    const agenda = await getJson<AgendaResp>(`/api/tasks/agenda`);
    expect(Object.values(agenda.buckets).flat().some((t) => t.node_id === v10.id), "owner task bucketed again").toBe(true);
  });

  // ── LAW 1 — read-policy totality ──────────────────────────────────────────

  it("LAW 1: a viewer outside the space sees the restricted variants on NO read surface", async () => {
    currentActor = viewer;
    for (const [label, p] of [["v1", v1], ["v2a", v2a], ["v6", v6]] as Array<[string, V]>) {
      await expectAbsentEverywhere(p, `viewer (${label})`);
    }
  });

  it("LAW 1: an empty-read-scope bearer token sees NOTHING — every note variant, every surface", async () => {
    currentActor = emptyToken;
    // v7's carrier is a class_tag node: tag definitions are global (readable
    // by every member, spaces model), so it is outside this law by design.
    for (const [label, p] of allVariants().filter(([, v]) => v !== v7)) {
      await expectAbsentEverywhere(p, `empty-scope token (${label})`);
    }
    currentActor = admin;
  });

  // ── LAW 2 — restore round-trip ────────────────────────────────────────────

  // Each variant gets its own timeout and awaited cleanup boundary. Ten 400ms
  // settle waits plus all API calls in one test nearly consume the 5s deadline
  // even on an empty DB; timeout must not let the next variant race this one.
  it.each(allVariants().map(([label],index) => ({label,index})))("LAW 2: $label — body restore preserves all decorations", async ({index}) => {
    currentActor = admin;
    const [label,p] = allVariants()[index]!;
    const originalBody = await markdownOf(p.id);
    const res = await patch(`/api/nodes/${p.id}`, { markdown: `${originalBody}\n\nlaw-2 churn ${stamp}` });
    expect(res.status, `${label}: PATCH`).toBe(200);
    await settle(); // post-commit attribute re-derivation is idempotent here
    const before = await decorations(p.id);
    const evId = await latestEventId(p.id, "NODE_UPDATED");
    const restored = await post(`/api/events/${evId}/restore`, {});
    expect(restored.status, `${label}: restore`).toBe(200);
    expect(await markdownOf(p.id), `${label}: body returned by inverse patch`).toBe(originalBody);
    expect(await decorations(p.id), `${label}: decorations untouched by restore`).toEqual(before);
  });

  // ── LAW 3 — soft-delete round-trip ────────────────────────────────────────

  it.each(allVariants().map(([label],index) => ({label,index})))("LAW 3: $label — delete/undelete preserves all decorations", async ({index}) => {
    currentActor = admin;
    const [label,p] = allVariants()[index]!;
    const before = await decorations(p.id);
    expect((await del(`/api/nodes/${p.id}`)).status, `${label}: delete`).toBe(200);
    await expectAbsentEverywhere(p, `admin (${label} trashed)`, { listOnly: true });
    expect((await post(`/api/nodes/${p.id}/undelete`)).status, `${label}: undelete`).toBe(200);
    expect(await decorations(p.id), `${label}: decoration set identical after the round-trip`).toEqual(before);
  });

  it("LAW 3 epilogue: after all round-trips the unrestricted control is fully visible again", async () => {
    currentActor = viewer;
    await expectVisibleOn(v5, [
      "GET /api/nodes/search",
      "POST /api/query (by marker tag)",
      "GET /api/tasks/agenda",
    ], "viewer");
    currentActor = admin;
  });
});
