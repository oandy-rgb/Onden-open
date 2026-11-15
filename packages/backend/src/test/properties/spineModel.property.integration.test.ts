// Model-based random test of the write gate (spine/mutate.ts) and the read
// scope (services/readPolicy.ts, spine/spaceScope.ts), through the REAL app.
//
// permissions.property.integration.test.ts already follows permission CHANGES
// over time for reads, edits, tags, moves, deletes and the MCP tool gate. This
// file asks what that one does not:
//
//   A. Every write leaves exactly the trace the gate promises. A refused write
//      adds no event the caller authored; an allowed one adds exactly one root
//      event (create, edit, delete, link), attributed to the caller, and every
//      cascaded event points at one of the new events. The database equals the
//      model after every command, so a refused write also changed no row.
//   B. Nothing leaks out of a space through the other read paths: search (REST
//      and the MCP searchNodes tool), bootstrap edges, events, the History pages,
//      one note's history and versions, the "as it was at" view, and the
//      Markdown export. A response never carries the id or the text of a note
//      the model says the caller cannot read.
//   C. The History writes obey the same gate: rewind to a moment, undo a rewind,
//      restore one saved version, restore one event, link two notes (a
//      backlink). Their effect is not predicted line by line; what is checked is
//      that they never touch a note the caller cannot write (no row change, no
//      event), that what they report as restored is writable, and that a rewound
//      note really has the body it had at that moment.
//
// Model: helpers/spaceModel.ts (the rule, also checked without a database in
// spaceModel.property.test.ts). Actors: the owner, members A and B, and one
// agent G reached through one bearer token. Spaces, notes (with parents),
// members and their view/edit permission, the "AI can read" switch, links
// between notes, the token's access and whether it is revoked.
//
// Commands: create a space; create a note (a person, or the token through
// createNode); edit body or title; move a note with its subtree; delete;
// restore a deleted note; link two notes; change a member (view / edit /
// removed); switch "AI can read"; mint / revoke / re-access the token; take a
// checkpoint; rewind to a checkpoint; undo a rewind; restore a saved version;
// restore an event; sweep every read path as one actor.
//
// Run count and seed: PROPS_RUNS (default 10 here) and PROPS_SEED
// (helpers/propsConfig.ts). A failure prints the seed and the shrunk command
// sequence:
//   PROPS_SEED=123 PROPS_RUNS=60 npx vitest run src/test/properties/spineModel.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import fc from "fast-check";
import { q, getWorkspaceId } from "../../db.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync, PROPS_SEED } from "../helpers/propsConfig.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { zipEntries } from "../helpers/zipEntries.js";
import { _resetRateLimits } from "../../services/agentTools/rateLimit.js";
import {
  WHO, canReadIn, canWriteIn, deleteSubtree, hiddenFrom, memberOf, moveSubtree, newModel, tokenDead, undeleteSubtree, visible, visibleIds, writable,
  type Access, type Member, type Model, type MNote, type MSpace, type Perm, type Who,
} from "../helpers/spaceModel.js";
import { turnModuleOn } from "../helpers/setModulesOn.js";

// The file's own workspace, not the shared 'default' one: every read path here (bootstrap, search, export) reads the
// whole workspace, and in a full run 'default' holds what every other file left there (a 5 s timeout with 3000 notes).
let ownWorkspace = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

// Identity comes from the REAL actors table through external_id; only the
// session lookup is replaced (as in permissions.property.integration.test.ts).
let sessionExternalId: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: "Spine Props", email: `${sessionExternalId}@props.test` } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../../app.js");
registerShippedModules();

type Real = {
  ws: string;
  stamp: string;
  ext: Record<"owner" | "A" | "B", string>;
  ids: Record<Member, string>;
  counter: number;
};
/** The shared model plus what only the History commands need. */
type RunModel = Model & {
  /** Checkpoints taken so far: an ISO time and the live notes' text at that moment. */
  checkpoints: Array<{ at: string; notes: Map<string, { title: string; body: string }> }>;
  /** The latest rewind's id, for "undo a rewind". */
  lastRewind: string | null;
};
type Res = { status: number; json: any; text: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const is2xx = (s: number) => s >= 200 && s < 300;
const pick = <T>(xs: T[], i: number): T => xs[i % xs.length]!;
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
/** Block ids (`^id`) are added to the stored body; the model keeps the text without them. */
const stripBlockIds = (s: string) => s.replace(/[ \t]*\^[\w-]+[ \t]*$/gm, "").trimEnd();

class ModelMismatch extends Error {}
const fail = (what: string): never => { throw new ModelMismatch(what); };

// ── Requests ─────────────────────────────────────────────────────────────────
async function send(r: Real, m: Model, who: Who, method: string, path: string, body?: unknown): Promise<{ res: Response; bytes: Buffer }> {
  const headers: Record<string, string> = {};
  if (who === "tok") {
    headers.authorization = `Bearer ${m.token!.plaintext}`;
    await _resetRateLimits(); // 60 tool calls / minute / agent: a model run makes more
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  sessionExternalId = who === "tok" ? null : r.ext[who];
  try {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  } finally {
    sessionExternalId = null;
  }
}

async function call(r: Real, m: Model, who: Who, method: string, path: string, body?: unknown): Promise<Res> {
  const { res, bytes } = await send(r, m, who, method, path, body);
  const text = bytes.toString("utf8");
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const tool = (r: Real, m: Model, who: Who, name: string, args: unknown) => call(r, m, who, "POST", `/api/mcp/tools/${name}`, args);

/** The caller's reply to a write the model predicts: allowed and effective, or
 *  refused with 403/404 (401 for a revoked token). Never a 5xx. */
function expectOutcome(what: string, res: Res, allowed: boolean, dead: boolean): void {
  const seen = `${what}: got ${res.status} ${res.text.slice(0, 140)}`;
  if (dead) { if (res.status !== 401) fail(`${seen}; a revoked token must be refused with 401`); return; }
  if (allowed) { if (!is2xx(res.status)) fail(`${seen}; the model says this is allowed`); return; }
  if (res.status !== 403 && res.status !== 404) fail(`${seen}; the model says this is refused (403/404)`);
}

// ── The event log ───────────────────────────────────────────────────────────
type Ev = { id: string; event_type: string; actor_type: string; actor_id: string; target_id: string; cause: string | null };

const lastEventId = async (ws: string) =>
  (await q<{ m: string }>(`SELECT COALESCE(MAX(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.m;

const eventsAfter = async (ws: string, mark: string): Promise<Ev[]> =>
  (await q<Ev>(
    `SELECT id::text, event_type, actor_type, actor_id, target_id, triggered_by_event_id::text AS cause
       FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint ORDER BY domain_events.id`, [ws, mark])).rows;

/** Run one write and check the events it left against what the gate promises. */
async function traced(
  r: Real, m: Model, who: Who, what: string, allowed: boolean, roots: "one" | "some", run: () => Promise<Res>,
): Promise<Res> {
  const mark = await lastEventId(r.ws);
  const res = await run();
  const dead = tokenDead(m, who);
  expectOutcome(what, res, allowed, dead);
  const all = await eventsAfter(r.ws, mark);
  // An MCP tool call also leaves its own audit row (AGENT_TOOL_CALLED /
  // AGENT_TOOL_FAILED, agentTools/registry.ts callTool): the record of the
  // call, not a write, so it is not one of the write's events.
  const own = all.filter((e) => e.actor_type !== "system" && e.event_type !== "AGENT_TOOL_CALLED" && e.event_type !== "AGENT_TOOL_FAILED");
  if (!allowed || dead) {
    if (own.length) fail(`${what}: was refused but left events [${own.map((e) => `${e.event_type}#${e.id}`).join(", ")}]`);
    return res;
  }
  const rootEvents = own.filter((e) => e.cause === null);
  if (roots === "one" && rootEvents.length !== 1) {
    fail(`${what}: an allowed write must leave exactly one root event, found [${rootEvents.map((e) => e.event_type).join(", ")}]`);
  }
  if (roots === "some" && rootEvents.length < 1) fail(`${what}: an allowed write left no event`);
  const actorId = r.ids[memberOf(who)], actorType = who === "tok" ? "ai_agent" : "user";
  for (const e of own) {
    if (e.actor_id !== actorId || e.actor_type !== actorType) fail(`${what}: ${e.event_type} is attributed to ${e.actor_type}/${e.actor_id}, not the caller`);
  }
  const known = new Set(all.map((e) => e.id));
  for (const e of all) if (e.cause !== null && !known.has(e.cause)) fail(`${what}: ${e.event_type} points at event ${e.cause}, which this write did not make`);
  return res;
}

// ── The database must equal the model ───────────────────────────────────────
let currentIds: Record<Member, string> = { owner: "", A: "", B: "", G: "" };

async function assertDatabaseMatchesModel(m: Model, ctx: string): Promise<void> {
  if (m.notes.length) {
    const rows = (await q<{ id: string; title: string; markdown: string; space_id: string; parent_id: string | null; deleted: boolean }>(
      `SELECT id::text, title, markdown, space_id::text, parent_id::text, (deleted_at IS NOT NULL) AS deleted
         FROM content_nodes WHERE id = ANY($1::uuid[])`, [m.notes.map((n) => n.id)])).rows;
    for (const n of m.notes) {
      const row = rows.find((x) => x.id === n.id);
      if (!row) { fail(`${ctx}: ${n.mark} is missing from the database`); continue; }
      const diff = [
        row.title !== n.title && `title ${JSON.stringify(row.title)} ≠ ${JSON.stringify(n.title)}`,
        stripBlockIds(row.markdown) !== n.body && `body ${JSON.stringify(row.markdown)} ≠ ${JSON.stringify(n.body)}`,
        row.space_id !== n.space && "space differs",
        row.parent_id !== n.parent && "parent differs",
        row.deleted !== n.deleted && `deleted ${row.deleted} ≠ ${n.deleted}`,
      ].filter(Boolean);
      if (diff.length) fail(`${ctx}: the database differs from the model for ${n.mark}: ${diff.join("; ")}`);
    }
  }
  for (const s of m.spaces) {
    const have = (await q<{ actor_id: string; permission: Perm }>(`SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [s.id])).rows
      .map((x) => `${Object.entries(currentIds).find(([, id]) => id === x.actor_id)?.[0] ?? x.actor_id}:${x.permission}`).sort().join(",");
    const want = [...s.members].map(([k, p]) => `${k}:${p}`).sort().join(",");
    if (have !== want) fail(`${ctx}: members of a space are ${have}, the model says ${want}`);
    const ai = (await q<{ ai: string | null }>(`SELECT capabilities->>'external_ai' AS ai FROM spaces WHERE id = $1`, [s.id])).rows[0]?.ai;
    if ((ai === "true") !== s.externalAi) fail(`${ctx}: external_ai is ${ai}, the model says ${s.externalAi}`);
  }
  const edges = (await q<{ id: string }>(`SELECT id::text FROM node_edges WHERE id = ANY($1::uuid[])`, [m.edges.map((e) => e.id)])).rows;
  if (edges.length !== m.edges.length) fail(`${ctx}: ${edges.length} of the model's ${m.edges.length} links exist`);
  if (m.token) {
    const row = (await q<{ access: string; revoked: boolean }>(
      `SELECT access, (revoked_at IS NOT NULL) AS revoked FROM agent_tokens WHERE id = $1`, [m.token.id])).rows[0];
    if (!row || row.access !== m.token.access || row.revoked !== m.token.revoked) fail(`${ctx}: token row ${JSON.stringify(row)} differs from the model`);
  }
}

/** Take a note's text from the database (after a write whose exact effect is not predicted). */
async function resyncText(n: MNote): Promise<void> {
  const row = (await q<{ title: string; markdown: string }>(`SELECT title, markdown FROM content_nodes WHERE id = $1`, [n.id])).rows[0]!;
  n.title = row.title;
  n.body = stripBlockIds(row.markdown);
}

/** A fingerprint of everything about notes: rows, tags, and the events that target them. */
async function fingerprint(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = (await q<{ id: string; fp: string }>(
    `SELECT n.id::text,
            concat_ws('|', n.title, n.markdown, n.space_id, COALESCE(n.parent_id::text, ''), (n.deleted_at IS NOT NULL)::text,
              COALESCE((SELECT string_agg(t.tag_id::text, ',' ORDER BY t.tag_id) FROM node_tags t WHERE t.node_id = n.id), ''),
              (SELECT count(*) FROM domain_events e WHERE e.target_id = n.id::text)::text) AS fp
       FROM content_nodes n WHERE n.id = ANY($1::uuid[])`, [ids])).rows;
  for (const row of rows) out.set(row.id, row.fp);
  return out;
}

// ── Leaks: what a response is allowed to carry ──────────────────────────────
/** No response may carry the id or the text of a note the caller cannot read.
 *  `asked`: the text a search was for, which a reply may repeat without leaking. */
function assertNoLeak(label: string, m: Model, who: Who, body: string, asked?: string): void {
  if (!body) return;
  for (const n of hiddenFrom(m, who)) {
    if (n.mark !== asked && body.includes(n.mark)) fail(`${label}: shows the text of ${n.mark}, which ${who} cannot read`);
    // Old events of a note may still name the id of the parent it left behind.
    if (!n.lostChild && body.includes(n.id)) fail(`${label}: names ${n.mark} (${n.id}), which ${who} cannot read`);
  }
}

/** Ids from `ids` that belong to this run's notes. */
const mine = (m: Model, ids: string[]) => ids.filter((id) => m.notes.some((n) => n.id === id));

async function probeSearch(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  const label = `${who} searches for ${n.mark}`;
  const dead = tokenDead(m, who);
  if (who === "tok") {
    const res = await tool(r, m, who, "searchNodes", { query: n.mark });
    if (dead) return expectOutcome(label, res, false, true);
    if (res.status !== 200) fail(`${label}: ${res.status} ${res.text.slice(0, 100)}`);
    assertNoLeak(label, m, who, res.text, n.mark);
    return;
  }
  const res = await call(r, m, who, "GET", `/api/nodes/search?q=${encodeURIComponent(n.mark)}`);
  if (res.status !== 200) fail(`${label}: ${res.status} ${res.text.slice(0, 100)}`);
  assertNoLeak(label, m, who, res.text, n.mark);
  const found = mine(m, (res.json as Array<{ id: string }>).map((x) => x.id));
  for (const id of found) if (!visibleIds(m, who).includes(id)) fail(`${label}: found ${m.notes.find((x) => x.id === id)!.mark}, which ${who} cannot see`);
}

/** Bootstrap: the exact set of notes and links, and no leak anywhere in it. */
async function probeBootstrap(r: Real, m: Model, who: Who): Promise<void> {
  const res = await call(r, m, who, "GET", "/api/bootstrap");
  if (who === "tok") return expectOutcome("tok GET /api/bootstrap", res, false, tokenDead(m, who));
  if (res.status !== 200) fail(`${who} bootstrap: ${res.status}`);
  const want = visibleIds(m, who);
  const got = mine(m, (res.json.nodes as Array<{ id: string }>).map((n) => n.id));
  if (!sameSet(got, want)) fail(`${who} bootstrap: lists [${got.map((id) => m.notes.find((n) => n.id === id)!.mark)}], the model says [${want.map((id) => m.notes.find((n) => n.id === id)!.mark)}]`);
  // A link is shown only when both ends are visible; and then it is shown.
  const wantEdges = m.edges.filter((e) => want.includes(e.from) && want.includes(e.to)).map((e) => e.id);
  const gotEdges = (res.json.edges as Array<{ id: string }>).map((e) => e.id).filter((id) => m.edges.some((e) => e.id === id));
  if (!sameSet(gotEdges, wantEdges)) fail(`${who} bootstrap: shows ${gotEdges.length} of this run's links, the model says ${wantEdges.length}`);
  assertNoLeak(`${who} bootstrap`, m, who, res.text);
}

/** The History pages, the event list, one note's history and versions, and the export. */
async function probeHistory(r: Real, m: Model, who: Who): Promise<void> {
  if (who === "tok") {
    // A token reaches only /api/mcp; a person's History is not a token's to read.
    const res = await call(r, m, who, "GET", "/api/history/feed?days=31");
    return expectOutcome("tok GET /api/history/feed", res, false, tokenDead(m, who));
  }
  const now = new Date().toISOString();
  const paths = [
    "/api/history/feed?days=31", "/api/history/activity?days=30", "/api/history/day", "/api/history/deleted?days=30",
    `/api/history/at?t=${encodeURIComponent(now)}`, "/api/events?limit=500", "/api/events?limit=500&deleted=1", "/api/versions/recent",
  ];
  for (const path of paths) {
    const res = await call(r, m, who, "GET", path);
    if (res.status !== 200) fail(`${who} GET ${path}: ${res.status} ${res.text.slice(0, 100)}`);
    assertNoLeak(`${who} GET ${path.split("?")[0]}`, m, who, res.text);
  }
  for (const n of m.notes) {
    for (const path of [`/api/nodes/${n.id}/history`, `/api/nodes/${n.id}/versions?raw=1`, `/api/history/at/${n.id}?t=${encodeURIComponent(now)}`]) {
      const res = await call(r, m, who, "GET", path);
      // Unreadable = missing (no existence probe); a readable live note answers.
      if (hiddenFrom(m, who).includes(n) && res.status !== 404) fail(`${who} GET ${path.replace(n.id, n.mark)}: ${res.status}, a note outside ${who}'s spaces must be 404`);
      if (visible(m, who, n) && path.includes("/history") && !path.includes("/at/") && res.status !== 200) fail(`${who} GET ${path.replace(n.id, n.mark)}: ${res.status}, the model says ${who} can read it`);
      assertNoLeak(`${who} GET ${path.replace(n.id, n.mark)}`, m, who, res.text);
    }
  }
  // The export: when it answers, it holds nothing from a space the caller is not in.
  const zip = await send(r, m, who, "GET", "/api/export/markdown.zip");
  if (zip.res.status === 200) {
    const files = zipEntries(zip.bytes);
    for (const [name, data] of files) assertNoLeak(`${who} export (${name})`, m, who, `${name}\n${data.toString("utf8")}`);
  } else if (zip.res.status !== 403 && zip.res.status !== 404) fail(`${who} export: ${zip.res.status}`);
}

/** Every read path as one actor, for the very next request after a change. */
async function sweep(r: Real, m: Model, who: Who): Promise<void> {
  if (who === "tok" && !m.token) return;
  await probeBootstrap(r, m, who);
  await probeHistory(r, m, who);
  for (const n of m.notes.slice(0, 4)) await probeSearch(r, m, who, n);
}

// ── Writes ──────────────────────────────────────────────────────────────────
const spaceFor = (m: Model, id: string) => m.spaces.find((s) => s.id === id)!;

async function writeEdit(r: Real, m: Model, who: Who, n: MNote, what: "body" | "title"): Promise<void> {
  const value = `${n.mark} ${what} ${++r.counter}`;
  const label = `${who} edits the ${what} of ${n.mark}`;
  const res = await traced(r, m, who, label, writable(m, who, n), "one", async () => {
    if (who === "tok") {
      const base = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [n.id])).rows[0]!.markdown;
      return tool(r, m, who, "updateNode", what === "body" ? { id: n.id, markdown: value, base_markdown: base } : { id: n.id, title: value });
    }
    return call(r, m, who, "PATCH", `/api/nodes/${n.id}`, what === "body" ? { markdown: value } : { title: value });
  });
  if (is2xx(res.status)) { if (what === "body") n.body = value; else n.title = value; }
}

async function writeCreate(r: Real, m: Model, who: Who, space: MSpace, parent: MNote | null): Promise<void> {
  const k = ++r.counter;
  const mark = `zq${r.stamp}n${String(k).padStart(3, "0")}`;
  // The token has no space argument it may rely on: it creates under a note.
  const target = who === "tok" ? parent!.space : space.id;
  const allowed = canWriteIn(m, who, target) && (parent === null || !parent.deleted);
  const label = `${who} creates ${mark} in ${who === "tok" ? "the space of a note" : "a space"}`;
  const res = await traced(r, m, who, label, allowed, "one", async () => who === "tok"
    ? tool(r, m, who, "createNode", { title: `${mark} title`, markdown: `${mark} body`, parent_id: parent!.id })
    : call(r, m, who, "POST", "/api/nodes", { title: `${mark} title`, markdown: `${mark} body`, space_id: space.id, ...(parent ? { parent_id: parent.id } : {}) }));
  if (is2xx(res.status)) {
    const id: string = who === "tok" ? res.json?.result?.id : res.json?.id;
    if (!id) fail(`${label}: no id in ${res.text.slice(0, 100)}`);
    m.notes.push({ id, mark, space: target, everIn: new Set([target]), parent: parent?.id ?? null, title: `${mark} title`, body: `${mark} body`, deleted: false, deletedBy: null, lostChild: false });
  }
}

async function writeDelete(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  // MCP has no delete tool and a token may not use REST: a token's delete is always refused.
  const allowed = who !== "tok" && writable(m, who, n);
  await traced(r, m, who, `${who} deletes ${n.mark}`, allowed, "one", () => call(r, m, who, "DELETE", `/api/nodes/${n.id}`));
  if (allowed) deleteSubtree(m, n);
}

async function writeUndelete(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  const allowed = who !== "tok" && canWriteIn(m, who, n.space);
  await traced(r, m, who, `${who} restores ${n.mark}`, allowed, "some", () => call(r, m, who, "POST", `/api/nodes/${n.id}/undelete`));
  if (allowed) undeleteSubtree(m, n);
}

async function writeMove(r: Real, m: Model, who: Who, n: MNote, to: MSpace): Promise<void> {
  // Moving needs the owner's hand; a token may not use REST.
  const allowed = who === "owner" && !n.deleted;
  const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [r.ws])).rows[0]!.e;
  await traced(r, m, who, `${who} moves ${n.mark} to another space`, allowed, "some",
    () => call(r, m, who, "POST", "/api/spaces/move", { node_id: n.id, to_space_id: to.id, membership_epoch: epoch }));
  if (allowed) moveSubtree(m, n, to.id);
}

/** A link from one note to another (what the target shows as a backlink). */
async function writeLink(r: Real, m: Model, who: Who, from: MNote, to: MNote): Promise<void> {
  // Write on the source, read on the target (a hidden target answers 404, not 403); a token may not use REST.
  const allowed = who !== "tok" && writable(m, who, from) && visible(m, who, to);
  const res = await traced(r, m, who, `${who} links ${from.mark} to ${to.mark}`, allowed, "one",
    () => call(r, m, who, "POST", "/api/edges", { source_node_id: from.id, target_node_id: to.id, edge_type: "related" }));
  if (is2xx(res.status)) {
    if (!res.json?.id) fail(`link: no id in ${res.text.slice(0, 100)}`);
    m.edges.push({ id: res.json.id, from: from.id, to: to.id });
  }
}

// The History writes. Their exact effect is not predicted; they are checked for
// what they must never do (touch what the caller cannot write) and, for rewind,
// for the text they put back.

/** Run `send`, and check that notes the caller cannot write have not moved by a row or an event. */
async function guardedHistoryWrite(
  r: Real, m: Model, who: Who, label: string, accepted: (status: number) => boolean, run: () => Promise<Res>,
): Promise<Res | null> {
  const locked = m.notes.filter((n) => !writable(m, who, n));
  const before = await fingerprint(locked.map((n) => n.id));
  const dead = tokenDead(m, who);
  const mark = await lastEventId(r.ws);
  const res = await run();
  const tokenOnRest = who === "tok";
  if (dead || tokenOnRest) {
    expectOutcome(label, res, false, dead);
  } else if (!accepted(res.status)) {
    fail(`${label}: got ${res.status} ${res.text.slice(0, 140)}`);
  }
  const after = await fingerprint(locked.map((n) => n.id));
  for (const n of locked) {
    if (before.get(n.id) !== after.get(n.id)) fail(`${label}: changed ${n.mark}, which ${who} cannot write`);
  }
  if (!is2xx(res.status)) {
    const own = (await eventsAfter(r.ws, mark)).filter((e) => e.actor_type !== "system");
    if (own.length) fail(`${label}: answered ${res.status} but left events [${own.map((e) => e.event_type).join(", ")}]`);
    return null;
  }
  return res;
}

async function takeCheckpoint(m: RunModel): Promise<void> {
  await sleep(4); // events of the last command are older than the checkpoint, the next command's are newer
  const at = (await q<{ t: string }>(`SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0]!.t;
  await sleep(4);
  m.checkpoints.push({ at, notes: new Map(m.notes.filter((n) => !n.deleted).map((n) => [n.id, { title: n.title, body: n.body }])) });
  if (m.checkpoints.length > 3) m.checkpoints.shift();
}

async function writeRewind(r: Real, m: RunModel, who: Who, ci: number): Promise<void> {
  const cp = pick(m.checkpoints, ci);
  // Ask for every live note, the caller's and not: the gate decides.
  const ask = m.notes.filter((n) => !n.deleted).map((n) => n.id);
  const res = await guardedHistoryWrite(r, m, who, `${who} rewinds to a checkpoint`, is2xx,
    () => call(r, m, who, "POST", "/api/history/rewind", { t: cp.at, restore_ids: ask, undelete_ids: [], delete_ids: [] }));
  if (!res) return;
  for (const id of (res.json?.restored ?? []) as string[]) {
    const n = m.notes.find((x) => x.id === id);
    if (!n) continue;
    if (!writable(m, who, n)) fail(`${who} rewind: reports ${n.mark} restored, which ${who} cannot write`);
    const then = cp.notes.get(id);
    if (!then) fail(`${who} rewind: reports ${n.mark} restored, but it did not exist at the checkpoint`);
    await resyncText(n);
    if (n.title !== then!.title || n.body !== then!.body) {
      fail(`${who} rewind: ${n.mark} is ${JSON.stringify(n.body)} / ${JSON.stringify(n.title)}, it was ${JSON.stringify(then!.body)} / ${JSON.stringify(then!.title)} at the checkpoint`);
    }
  }
  m.lastRewind = res.json?.rewind_id ?? null;
  // Anything else the rewind did is the caller's own writable notes: take their text.
  for (const n of m.notes.filter((x) => writable(m, who, x))) await resyncText(n);
}

async function writeUndoRewind(r: Real, m: RunModel, who: Who): Promise<void> {
  const ids = m.notes.map((n) => n.id);
  // A rewind that is gone, or has nothing left to undo, may answer 404/409/410; never a refusal that touched a locked note.
  const res = await guardedHistoryWrite(r, m, who, `${who} undoes the last rewind`,
    (s) => is2xx(s) || s === 404 || s === 409 || s === 410,
    () => call(r, m, who, "POST", `/api/history/rewinds/${m.lastRewind}/undo`, { node_ids: ids }));
  if (res) for (const n of m.notes.filter((x) => writable(m, who, x))) await resyncText(n);
}

async function versionIdsOf(r: Real, m: Model, n: MNote): Promise<string[]> {
  const res = await call(r, m, "owner", "GET", `/api/nodes/${n.id}/versions?raw=1`);
  if (res.status !== 200) return [];
  const list: Array<{ id: string }> = Array.isArray(res.json) ? res.json : res.json?.versions ?? [];
  return list.map((v) => String(v.id));
}

async function writeRestoreVersion(r: Real, m: Model, who: Who, n: MNote, vi: number): Promise<void> {
  const versions = await versionIdsOf(r, m, n);
  if (!versions.length) return;
  const versionId = pick(versions, vi);
  const label = `${who} restores a saved version of ${n.mark}`;
  const allowed = writable(m, who, n);
  const res = await guardedHistoryWrite(r, m, who, label,
    (s) => (allowed ? is2xx(s) || s === 409 || s === 422 : s === 403 || s === 404),
    () => call(r, m, who, "POST", `/api/nodes/${n.id}/versions/${versionId}/restore`));
  if (res && !allowed) fail(`${label}: succeeded, the model says ${who} cannot write it`);
  if (res) await resyncText(n);
}

async function writeRestoreEvent(r: Real, m: Model, who: Who, n: MNote, ei: number): Promise<void> {
  const listed = await call(r, m, "owner", "GET", `/api/events?target_id=${n.id}&event_type=NODE_UPDATED&limit=20`);
  const events: Array<{ id: string }> = listed.json?.events ?? [];
  if (!events.length) return;
  const eventId = String(pick(events, ei).id);
  const label = `${who} restores event #${eventId} of ${n.mark}`;
  const allowed = writable(m, who, n);
  const res = await guardedHistoryWrite(r, m, who, label,
    (s) => (allowed ? is2xx(s) || s === 409 || s === 410 || s === 422 : s === 403 || s === 404),
    () => call(r, m, who, "POST", `/api/events/${eventId}/restore`, {}));
  if (res && !allowed) fail(`${label}: succeeded, the model says ${who} cannot write it`);
  if (res) await resyncText(n);
}

// ── Commands ─────────────────────────────────────────────────────────────────
type Cmd = fc.AsyncCommand<RunModel, Real>;
const idx = fc.nat(9);

function command(name: string, check: (m: RunModel) => boolean, run: (m: RunModel, r: Real) => Promise<void>): Cmd {
  return {
    check,
    async run(m, r) {
      try {
        await run(m, r);
        await assertDatabaseMatchesModel(m, name);
      } catch (e) {
        if (e instanceof ModelMismatch) throw new ModelMismatch(`${name}\n    ${e.message}`);
        throw e;
      }
    },
    toString: () => name,
  };
}
const hasToken = (w: Who) => (m: Model) => w !== "tok" || m.token !== null;
const liveNotes = (m: Model) => m.notes.filter((n) => !n.deleted);

const createSpace = () => command("owner creates a space", (m) => m.spaces.length < 3, async (m, r) => {
  const res = await call(r, m, "owner", "POST", "/api/spaces", { name: `spine space ${++r.counter}` });
  if (res.status !== 201) fail(`create space: ${res.status} ${res.text.slice(0, 120)}`);
  m.spaces.push({ id: res.json.id, externalAi: false, members: new Map([["owner", "edit"]]) });
});

const setMember = (si: number, who: Exclude<Member, "owner">, perm: Perm | null) => command(
  `owner ${perm === null ? `removes ${who} from` : `sets ${who} to ${perm} in`} space ${si}`,
  (m) => m.spaces.length > 0 && (perm !== null || pick(m.spaces, si).members.has(who)),
  async (m, r) => {
    const s = pick(m.spaces, si);
    const id = r.ids[who];
    const res = perm === null ? await call(r, m, "owner", "DELETE", `/api/spaces/${s.id}/members/${id}`)
      : await call(r, m, "owner", "PUT", `/api/spaces/${s.id}/members/${id}`, { permission: perm });
    if (!is2xx(res.status)) fail(`set member: ${res.status} ${res.text.slice(0, 120)}`);
    if (perm === null) s.members.delete(who); else s.members.set(who, perm);
    await sweep(r, m, who === "G" ? "tok" : who); // the very next reads already follow the change
  });

const toggleAi = (si: number, on: boolean) => command(`owner turns "AI can read" ${on ? "on" : "off"} in space ${si}`,
  (m) => m.spaces.length > 0, async (m, r) => {
    const s = pick(m.spaces, si);
    const res = await call(r, m, "owner", "PATCH", `/api/spaces/${s.id}`, { capabilities: { external_ai: on } });
    if (!is2xx(res.status)) fail(`toggle AI: ${res.status} ${res.text.slice(0, 120)}`);
    s.externalAi = on;
    await sweep(r, m, "tok");
  });

const mintToken = (access: Access) => command(`owner mints the token (${access})`,
  (m) => m.token === null || m.token.revoked, async (m, r) => {
    const res = await call(r, m, "owner", "POST", `/api/actors/${r.ids.G}/tokens`, { name: `spine-${++r.counter}`, access });
    if (res.status !== 201) fail(`mint token: ${res.status} ${res.text.slice(0, 120)}`);
    m.token = { id: res.json.id, plaintext: res.json.token, access, revoked: false };
    await sweep(r, m, "tok");
  });

const revokeToken = () => command("owner revokes the token", (m) => m.token !== null && !m.token.revoked, async (m, r) => {
  const res = await call(r, m, "owner", "POST", `/api/actors/${r.ids.G}/tokens/${m.token!.id}/revoke`);
  if (!is2xx(res.status)) fail(`revoke token: ${res.status} ${res.text.slice(0, 120)}`);
  m.token!.revoked = true;
  await sweep(r, m, "tok");
  if (m.notes[0]) await writeEdit(r, m, "tok", m.notes[0], "title"); // a revoked token is refused on a write too
});

const setTokenAccess = (access: Access) => command(`owner sets the token to ${access}`,
  (m) => m.token !== null && !m.token.revoked, async (m, r) => {
    const res = await call(r, m, "owner", "PATCH", `/api/actors/${r.ids.G}/tokens/${m.token!.id}`, { access });
    if (!is2xx(res.status)) fail(`set token access: ${res.status} ${res.text.slice(0, 120)}`);
    m.token!.access = access;
    for (const n of m.notes.slice(0, 3)) await writeEdit(r, m, "tok", n, "title"); // the next write already follows
  });

const create = (w: Who, si: number, withParent: boolean, pi: number) => command(
  `${w} creates a note (in space ${si}${withParent ? ", under a note" : ""})`,
  (m) => m.spaces.length > 0 && m.notes.length < 8 && hasToken(w)(m) && (w !== "tok" || liveNotes(m).length > 0),
  async (m, r) => {
    const space = pick(m.spaces, si);
    const inSpace = liveNotes(m).filter((n) => n.space === space.id);
    const parent = w === "tok" ? pick(liveNotes(m), pi) : withParent && inSpace.length ? pick(inSpace, pi) : null;
    // A person's parent must be in the space asked for; the token's space is its parent's.
    await writeCreate(r, m, w, w === "tok" ? spaceFor(m, parent!.space) : space, parent);
  });

const edit = (w: Who, ni: number, what: "body" | "title") => command(`${w} edits the ${what} of note ${ni}`,
  (m) => m.notes.length > 0 && hasToken(w)(m), (m, r) => writeEdit(r, m, w, pick(m.notes, ni), what));

const del = (w: Who, ni: number) => command(`${w} deletes note ${ni}`, (m) => m.notes.length > 0 && hasToken(w)(m), async (m, r) => {
  await writeDelete(r, m, w, pick(m.notes, ni));
  await sweep(r, m, w);
});

const restorable = (m: Model) => m.notes.filter((n) => n.deletedBy === n.id && (n.parent === null || !m.notes.find((p) => p.id === n.parent)!.deleted));
const undelete = (w: Who, ni: number) => command(`${w} restores deleted note ${ni}`, (m) => hasToken(w)(m) && restorable(m).length > 0, async (m, r) => {
  await writeUndelete(r, m, w, pick(restorable(m), ni));
  await sweep(r, m, w);
});

const move = (w: Who, ni: number, si: number) => command(`${w} moves note ${ni} to another space`,
  (m) => m.notes.length > 0 && m.spaces.length > 1 && hasToken(w)(m), async (m, r) => {
    const n = pick(m.notes, ni);
    await writeMove(r, m, w, n, pick(m.spaces.filter((s) => s.id !== n.space), si));
    for (const who of WHO) if (hasToken(who)(m)) await sweep(r, m, who);
  });

const link = (w: Who, a: number, b: number) => command(`${w} links note ${a} to note ${b}`,
  (m) => m.notes.length > 1 && hasToken(w)(m), async (m, r) => {
    const from = pick(m.notes, a), to = pick(m.notes, b);
    // A repeated or self link is a different question (a duplicate); keep to new pairs.
    if (from.id === to.id || m.edges.some((e) => e.from === from.id && e.to === to.id)) return;
    await writeLink(r, m, w, from, to);
    for (const who of WHO) if (hasToken(who)(m)) await probeBootstrap(r, m, who);
  });

const checkpoint = () => command("takes a checkpoint", () => true, (m) => takeCheckpoint(m));
const rewind = (w: Who, ci: number) => command(`${w} rewinds to checkpoint ${ci}`,
  (m) => m.checkpoints.length > 0 && hasToken(w)(m), async (m, r) => {
    await writeRewind(r, m, w, ci);
    await sweep(r, m, w);
  });
const undoRewind = (w: Who) => command(`${w} undoes the last rewind`, (m) => m.lastRewind !== null && hasToken(w)(m), async (m, r) => {
  await writeUndoRewind(r, m, w);
  await sweep(r, m, w);
});
const restoreVersion = (w: Who, ni: number, vi: number) => command(`${w} restores a saved version of note ${ni}`,
  (m) => liveNotes(m).length > 0 && hasToken(w)(m), (m, r) => writeRestoreVersion(r, m, w, pick(liveNotes(m), ni), vi));
const restoreEvent = (w: Who, ni: number, ei: number) => command(`${w} restores an event of note ${ni}`,
  (m) => liveNotes(m).length > 0 && hasToken(w)(m), (m, r) => writeRestoreEvent(r, m, w, pick(liveNotes(m), ni), ei));
const sweepAs = (w: Who) => command(`${w} reads every path (bootstrap, search, history, export)`, hasToken(w), (m, r) => sweep(r, m, w));

// generators ---------------------------------------------------------------
const whoArb = fc.constantFrom(...WHO);
const personArb = fc.constantFrom<Who>("owner", "A", "B");
const memberArb = fc.constantFrom<Exclude<Member, "owner">>("A", "B", "G");
const accessArb = fc.constantFrom<Access>("read", "write");

const commandArb = fc.oneof(...[
  { w: 3, a: fc.constant(null).map(createSpace) },
  { w: 6, a: fc.tuple(whoArb, idx, fc.boolean(), idx).map(([w, s, p, i]) => create(w, s, p, i)) },
  { w: 6, a: fc.tuple(memberArb, idx, fc.constantFrom<Perm | null>("view", "edit", "view", "edit", null)).map(([m, s, p]) => setMember(s, m, p)) },
  { w: 3, a: fc.tuple(idx, fc.boolean()).map(([s, on]) => toggleAi(s, on)) },
  { w: 2, a: accessArb.map(mintToken) },
  { w: 1, a: fc.constant(null).map(revokeToken) },
  { w: 2, a: accessArb.map(setTokenAccess) },
  { w: 6, a: fc.tuple(whoArb, idx, fc.constantFrom<"body" | "title">("body", "title")).map(([w, i, k]) => edit(w, i, k)) },
  { w: 3, a: fc.tuple(whoArb, idx, idx).map(([w, i, s]) => move(w, i, s)) },
  { w: 3, a: fc.tuple(whoArb, idx).map(([w, i]) => del(w, i)) },
  { w: 3, a: fc.tuple(whoArb, idx).map(([w, i]) => undelete(w, i)) },
  { w: 4, a: fc.tuple(whoArb, idx, idx).map(([w, a, b]) => link(w, a, b)) },
  { w: 3, a: fc.constant(null).map(checkpoint) },
  { w: 4, a: fc.tuple(whoArb, idx).map(([w, c]) => rewind(w, c)) },
  { w: 2, a: whoArb.map(undoRewind) },
  { w: 3, a: fc.tuple(whoArb, idx, idx).map(([w, n, v]) => restoreVersion(w, n, v)) },
  { w: 3, a: fc.tuple(whoArb, idx, idx).map(([w, n, e]) => restoreEvent(w, n, e)) },
  { w: 5, a: whoArb.map(sweepAs) },
].map(({ w, a }) => ({ weight: w, arbitrary: a as fc.Arbitrary<Cmd> })));

// ── The world of one run ────────────────────────────────────────────────────
let ws = "";
async function freshWorld(): Promise<{ model: RunModel; real: Real }> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const actor = async (label: string, type: "human" | "agent") => {
    const external = `spine-${label}-${stamp}`;
    const id = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [ws, `Spine ${label} ${stamp}`, type, external])).rows[0]!.id;
    return { id, external };
  };
  const owner = await actor("owner", "human"), a = await actor("A", "human"), b = await actor("B", "human"), agent = await actor("G", "agent");
  await setWorkspaceOwner(ws, owner.id);
  currentIds = { owner: owner.id, A: a.id, B: b.id, G: agent.id };
  const model: RunModel = { ...newModel(), checkpoints: [], lastRewind: null };
  const real: Real = {
    ws, stamp, ext: { owner: owner.external, A: a.external, B: b.external }, ids: currentIds,
    counter: 0,
  };
  // A starting position, so short sequences already have something to probe:
  // two spaces, A (view) and the agent (edit, AI on) in the first, B (edit) in
  // the second, a note in each, one under another, and a write token.
  await createSpace().run(model, real);
  await createSpace().run(model, real);
  await setMember(0, "A", "view").run(model, real);
  await setMember(0, "G", "edit").run(model, real);
  await setMember(1, "B", "edit").run(model, real);
  await toggleAi(0, true).run(model, real);
  await create("owner", 0, false, 0).run(model, real);
  await create("owner", 0, true, 0).run(model, real);
  await create("owner", 1, false, 0).run(model, real);
  await mintToken("write").run(model, real);
  return { model, real };
}

/** The property: any sequence of commands keeps every outcome and every trace equal to the model's. */
const spineProperty = () => fc.asyncProperty(
  fc.commands([commandArb], { maxCommands: 25, size: "max" }),
  async (cmds) => { await fc.asyncModelRun(freshWorld, cmds); },
);

// A larger run keeps the default small: PROPS_RUNS=60 for a bigger one.
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 10;

describe.skipIf(!isTestDatabase())("write gate and read scope (model-based, real app)", () => {
  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Spine model', $1) RETURNING id::text`, [`spine-${Date.now()}-${Math.floor(Math.random() * 1e6)}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    await turnModuleOn(ws, "ai"); // the agent tools belong to the AI module
    console.log(`[spineModel.property] PROPS_SEED=${PROPS_SEED} (replay with PROPS_SEED=${PROPS_SEED} PROPS_RUNS=<n>)`);
  });

  it("every write leaves the trace the gate promises, and no read path leaks a hidden note", async () => {
    await checkAsync(spineProperty(), RUN_CAP);
  }, 900_000);

  // Nightly 2026-11-10, PROPS_SEED=162580721 (PROPS_RUNS=5000). Invariant B broken: after B is removed from a space,
  // B's bootstrap still names a note of that space (B cannot read it). B had edit access and linked note 0 to note 1
  // first. Cause: the bootstrap event list kept the member's own EDGE_CREATED event, whose payload names both notes
  // (services/eventVisibility.ts now hides an actor's event once it names a note the actor cannot read).
  it("a removed member's bootstrap names no note of the space (seed 162580721)", async () => {
    const { model: m, real: r } = await freshWorld();
    await setMember(0, "B", "edit").run(m, r);
    await link("B", 0, 1).run(m, r);
    await setMember(0, "B", null).run(m, r);
  }, 60_000);

  // Sanity: the model and the real app agree on a hand-written sequence, so the
  // property cannot pass by every command no-opping.
  it("sanity: a member's edit leaves one event, a refused one none, and a hidden note stays out of search and the export", async () => {
    const { model: m, real: r } = await freshWorld();
    const mineBefore = m.notes.length;
    await setMember(0, "A", "edit").run(m, r);
    await edit("A", 0, "body").run(m, r); // allowed: exactly one root event
    expect(m.notes[0]!.body).toMatch(/body \d+$/);
    await setMember(0, "A", "view").run(m, r);
    await edit("A", 0, "body").run(m, r); // refused: no event, no row change
    await sweepAs("B").run(m, r); // B is not in space 0: nothing of notes 0 and 1 may appear
    expect(visibleIds(m, "B").length).toBeLessThan(mineBefore);
    expect(hiddenFrom(m, "B").map((n) => n.mark)).toContain(m.notes[0]!.mark);
    await checkpoint().run(m, r);
    await edit("owner", 0, "body").run(m, r);
    await rewind("owner", 0).run(m, r); // the owner's rewind puts the checkpoint text back
    await rewind("A", 0).run(m, r); // A has view only: nothing of space 0 is touched
  });
});
