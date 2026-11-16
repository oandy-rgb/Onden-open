// Cross-workspace sweep — can the owner of an unrelated workspace B read (or change) anything of workspace A?
//
// The route inventory is INTROSPECTED from the real assembled app (app.routes), so a route added tomorrow is swept
// without touching this file. A path param this file cannot fill FAILS the suite and names the route (extend
// fillParam() on purpose; never skip quietly). A route outside the public allowlist that does not answer an
// anonymous caller 401 fails too.
//
// World: two workspaces with one owner each. A holds the "open" group (notes, child note, tag, task, edge, canvas,
// media, RSS source, site settings, saved views, a member + token) and a "restricted" group in a space only A's owner
// is in. Every title / body / name carries a canary; every object id and slug of A is collected from the database
// itself (every table with a workspace_id column), so a new table is covered without being listed.
//
// One deployment serves one workspace (getWorkspaceId), so "B asks about A's objects" is: the deployment's workspace
// is B (workspaceSwitch), the caller is B's owner, and the path names A's ids. No header or query picks another
// workspace; the last test confirms that stays true.
//
//   GET, anonymous           → 401, except the PUBLIC allowlist below
//   GET, B's owner           → never 5xx; the body holds none of A's canaries, ids or slugs
//   GET, A's lowest member   → never 5xx; the body holds nothing of A's restricted space
//   write, B's owner         → never 5xx; A's rows are byte-for-byte unchanged afterwards
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { createTag } from "../services/tagHierarchy.js";
import { createEdge } from "../services/edgeWrites.js";
import { createStandaloneTask } from "../services/standaloneTasks.js";
import { addWhiteboardTab, setNodePosition } from "../services/boardStore.js";
import { storeMedia } from "../services/media.js";
import { createToken } from "../services/agentTokens.js";
import { createPointer } from "../services/pointers.js";
import { createSuggestions } from "../services/aiSuggestions.js";
import { appendEvent, configureRunner, setRunnerEnabled, startSession } from "../services/agentSessions.js";
import { saveSubscription } from "../services/pushSubscriptions.js";
import { createActor } from "../services/actors.js";
import { buildFullBackup } from "../services/backupArchive.js";
import { stageBackupUpload } from "../services/backupFile.js";
import { getRestoreJob, startRestoreJob } from "../services/backupRestoreJobs.js";
import { grade, replaceSettings } from "../modules/review/service.js";
import { addCalendar, saveFetchResult } from "../modules/external_calendars/store.js";
import { localDayId } from "../localDay.js";
import { writePref } from "../services/actorPrefs.js";
import { addCredential } from "../services/aiCredentials.js";
import { createBlockLink } from "../services/blockLinks.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { INK_CHUNK_THRESHOLD } from "../services/inkChunks.js";
import { recordMemberRemoval } from "../services/memberRemovals.js";
import { ensureSiteBundle } from "../modules/website/publishing/index.js";
import { recordSnapshotMedia } from "../services/snapshotMedia.js";
import { startFocus } from "../modules/tasks/focus.js";
import { markSeen } from "../modules/rss/staging.js";
import { mutatePersonal } from "../spine/mutate.js";
import { muteKeyword } from "../modules/rss/mutes.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";
import { freshWorkspace } from "./helpers/roundTripWorld.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { sessionActor } from "./helpers/agentSessionFixture.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";
import { seedView, seedViewElements } from "./helpers/seedView.js";
import { seedQ } from "./helpers/seedQ.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";
import { mountedRoutes, type MountedRoute } from "./helpers/appRoutes.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { snapshot, diffSnapshots, tablesMentioning } from "./helpers/workspaceSnapshot.js";

registerShippedModules();

// better-auth is mocked: the session names an external_id, resolved through the REAL actors table.
let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId ? { user: { id: sessionExternalId, name: "Sweep", email: `${sessionExternalId}@sweep.test` } } : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
// The deployment's workspace is whatever workspaceSwitch says (as in the round-trip tests).
vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
vi.mock("../services/workspaceId.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../services/workspaceId.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const { app } = await import("../app.js");
const enabled = isTestDatabase();
const SWEEP_TIMEOUT_MS = 60_000;
const STAMP = `${Date.now()}`;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ── What the routes may answer without a login ──────────────────────────────
// Mirrors app.ts (PUBLIC_PATHS, isPublicRead). Each line says why it is public.
const PUBLIC: Array<{ test: (p: string) => boolean; reason: string }> = [
  { test: (p) => p === "/health", reason: "readiness probe; answers { ok } and nothing about content" },
  { test: (p) => p === "/api/site", reason: "the published-site snapshot anonymous visitors render; only what the owner published" },
  { test: (p) => p.startsWith("/api/media/"), reason: "assets embedded in published pages; canReadMedia decides per file (checked for B below)" },
  { test: (p) => p.startsWith("/api/site/search.idx/"), reason: "the live site's search index, built from published pages only" },
];
const isPublic = (p: string) => PUBLIC.some((r) => r.test(p));

// Skipped, with the reason, instead of silently ignored.
//   /api/auth/*        better-auth's own endpoints; the handler is mocked here
//   /api/events/stream SSE: holds the connection open (the anonymous leg still covers it: the guard 401s first)
const SKIP_ALL = (p: string) => p.startsWith("/api/auth");
const SKIP_AUTHED = (p: string) => SKIP_ALL(p) || p === "/api/events/stream";

// ── The world ──────────────────────────────────────────────────────────────
type Group = {
  note: string; child: string; tag: string; task: string; edge: string; canvas: string; event: string;
  noteView: string; tagView: string; slug: string;
  pointer: string; session: string; suggestion: string;
  /** the note the agent was mentioned in (the session belongs to it) */
  mention: string;
};
type Side = { ws: string; owner: ActorCtx; ownerExternalId: string };
type World = {
  A: Side; B: Side;
  /** a third, unrelated workspace the write sweep acts from, so its changes never reach the read legs */
  C: Side;
  open: Group; restricted: Group;
  member: string; memberExternalId: string; memberToken: string;
  media: string; feed: string; article: string; space: string; restrictedSpace: string;
  attrKey: string;
  /** a pending invite (an actor row with no account yet), A's calendar, the upload waiting to be restored, the finished restore job */
  restoredSpace: string; agent: string; invite: string; calendar: string; upload: string; job: string;
  /** the review tag (module on) both groups' notes carry, and the day A has a day note for */
  reviewTag: string; day: string; block: string;
  /** every needle A holds: canaries, slugs, media file, uuids of every object */
  allNeedles: string[];
  restrictedNeedles: string[];
};
let W: World;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

const canary = (what: string) => `SWEEP${what}${STAMP}`;

async function externalId(actor: ActorCtx, label: string): Promise<string> {
  const ext = `sweep-${label}-${STAMP}`;
  await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [actor.id, ext]);
  return ext;
}

async function buildGroup(side: Side, label: "open" | "restricted", spaceId: string | null): Promise<Group> {
  const { ws, owner: actor } = side;
  const c = (what: string) => canary(`${label}${what}`);
  const tag = (await createTag({ actor, workspaceId: ws, name: c("Tag"), parentId: null })).id;
  const note = randomUUID(); const child = randomUUID();
  const common = { actor, workspaceId: ws, spaceId, event: { uiContext: "test.sweep" } } as const;
  await createNote({
    ...common, id: note, title: c("Title"), slug: c("slug").toLowerCase(),
    markdown: `${c("Body")} first paragraph\n\nsecond paragraph ${c("Para")}\n\n- [ ] ${c("Item")}`,
    tagIds: [tag], attributes: [{ key: "sweepattr", value: c("AttrValue"), value_type: "text" }],
  });
  await createNote({ ...common, id: child, title: c("Child"), markdown: `${c("ChildBody")}`, parentId: note });
  const edge = (await createEdge(actor, ws, { source_node_id: note, target_node_id: child, edge_type: "sweep_edge", status: "active" })).id;
  const task = await createStandaloneTask({ actor, workspaceId: ws, spaceId, title: c("Task"), markdown: c("TaskBody"), fields: { _task_status: "todo", _task_when: "2026-06-11" }, uiContext: "test.sweep" });
  const canvas = randomUUID();
  await createNote({
    ...common, id: canvas, title: c("Canvas"), nodeType: "canvas", slug: `canvas-${canvas}`,
    event: { type: "CANVAS_CREATED", targetType: "canvas", uiContext: "test.sweep" },
    within: ({ nodeId }) => addWhiteboardTab(nodeId),
  });
  await setNodePosition(ws, note, canvas, { x: 10, y: 10, width: 200, height: 100, color: null, folded: false });
  const tagView = await seedView(tag, { name: c("TagView") });
  const noteView = randomUUID();
  await seedViewElements(note, [{ id: noteView, tag_id: tag, name: c("NoteView"), layout: "list", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 0 }]);
  const event = (await q<{ id: string }>(
    `SELECT min(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2`, [ws, note])).rows[0]!.id;
  return { note, child, tag, task, edge, canvas, event, noteView, tagView, slug: c("slug").toLowerCase(), pointer: "", session: "", suggestion: "", mention: "" };
}

/** What A's owner / an agent / a reader leave behind per group: a pointer, an agent session with its log, a pending suggestion.
 *  Each carries its own canary and goes through the service the route uses. */
async function buildAgentThings(side: Side, g: Group, label: "open" | "restricted", spaceId: string | null, agent: { actor: ActorCtx; handle: string }): Promise<void> {
  const { ws, owner: actor } = side;
  const c = (what: string) => canary(`${label}${what}`);
  g.pointer = (await createPointer(actor, ws, { targetId: g.child, parentId: g.note, displayPrefix: c("Pointer") })).id;
  const mention = `@${agent.handle} ${c("AgentPrompt")} please tidy this`;
  const mentionNote = (await createNote({ actor, workspaceId: ws, spaceId, title: c("MentionNote"), markdown: mention, event: { uiContext: "test.sweep" } })).node.id as string;
  const { session } = await startSession(ws, { actor, nodeId: mentionNote, target: { blockText: mention } });
  g.session = session.id; g.mention = mentionNote;
  const sessionAs = await sessionActor(session, agent.actor);
  await appendEvent(session.id, { actor: sessionAs, seq: 1, kind: "thought", text: c("AgentThought") });
  await appendEvent(session.id, { actor: sessionAs, seq: 2, kind: "message", text: c("AgentMessage") });
  const made = await createSuggestions(ws, {
    actor, proposer: { agentActorId: agent.actor.id, sessionId: session.id }, nodeId: g.note,
    proposedMarkdown: `${c("Body")} first paragraph\n\n${c("Proposed")} replaces the second paragraph\n\n- [ ] ${c("Item")}`,
    comments: [{ text: c("SuggestComment"), anchorText: c("Item") }],
  });
  if (!made.suggestionId) throw new Error("sweep: the suggestion saved nothing");
  g.suggestion = made.suggestionId;
}

/** Every uuid `id` and every slug A holds, read from the tables themselves. */
async function harvestNeedles(ws: string): Promise<string[]> {
  const tables = (await q<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'workspace_id'`)).rows.map((r) => r.table_name);
  const out = new Set<string>([ws]);
  for (const table of tables) {
    const cols = (await q<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table])).rows;
    for (const col of cols) {
      const isIdColumn = col.column_name === "id" && col.data_type === "uuid";
      const isSlug = col.column_name === "slug" && col.data_type === "text";
      if (!isIdColumn && !isSlug) continue;
      const rows = (await q<{ v: string | null }>(`SELECT "${col.column_name}"::text AS v FROM "${table}" WHERE workspace_id = $1`, [ws])).rows;
      for (const r of rows) if (r.v && r.v.length >= 12) out.add(r.v);
    }
  }
  return [...out];
}

// ── Is every table that belongs to a workspace filled for A? ──────────────
// A table "belongs to" a workspace when it has a workspace_id column, or points (foreign key, up to three hops) at one that
// does; the two text-keyed tables are named in TEXT_KEYED. A new table therefore shows up here by itself: if the sweep
// does not seed it, the test below names it.
const TEXT_KEYED: Record<string, string> = {
  node_event_meta: `EXISTS (SELECT 1 FROM content_nodes p WHERE p.id::text = t.node_id AND p.workspace_id = $1)`,
};
// Tables that cannot be filled for ONE workspace, each with why. A table is added here only for a reason the table itself
// gives (it is not owned by a workspace, or it needs something this suite cannot start); not because filling it is work.
// ratchet:list sweep-unseeded-tables
const UNSEEDED_TABLES: Record<string, string> = {
  dispatcher_pending: "the queue of derived work not done yet (drained by awaitAllDispatchers); a row here is transient by design",
  owner_member_migration_log: "migration 097's own log of what it converted in the workspaces that existed then; nothing at runtime writes it",
  blobs: "content-addressed text shared by every workspace (keyed by hash); no workspace owns a row",
  rate_limit_hits: "per-IP / per-route counters of the whole server, written by the rate limiter, not by workspace data",
  schema_migrations: "the server's migration ledger",
  read_later_done_removed_192: "the old read-later \"finished\" marks, kept one release after the feature was removed (migration 192); nothing reads or writes it any more",
  sync_node: "this installation's node id, sequence number and clock for write stamps (a singleton; the stamps themselves are in sync_stamps, which has workspace_id)",
  ds_node: "distributed sync: this server's own node identity (a singleton), empty until sync is paired",
  ds_ops: "distributed sync: operations from paired peers; needs a second server",
  ds_peers: "distributed sync: paired peers; needs a second server",
  ds_rejections: "distributed sync: operations refused from a peer; needs a second server",
  ds_capture_cursor: "distributed sync: how far this server has captured its own events (a singleton)",
  ds_captured_events: "distributed sync: bookkeeping of the capture above",
  ds_unsupported: "distributed sync: counts of event types the bridge cannot carry",
  ds_projection_failures: "distributed sync: failures applying a peer's operation; needs a second server",
};

type ForeignKey = { t: string; col: string; parent: string; parentCol: string };
/** The tables Onden's own schema creates (db/schema.sql and the migrations). A test database is shared by the whole suite,
 *  and other tests leave tables that are not ours in it: the sign-in library makes its own (user, session, account,
 *  verification) the first time a test signs someone in, and the backup-move test stands in the browser app's
 *  browser_app_state. Whether THOSE name a workspace is not this suite's question, and counting them made the result
 *  depend on which test file ran first. */
function ownTables(): Set<string> {
  const dbDir = fileURLToPath(new URL("../../db/", import.meta.url));
  const files = [join(dbDir, "schema.sql"), ...readdirSync(join(dbDir, "migrations")).filter((f) => f.endsWith(".sql")).map((f) => join(dbDir, "migrations", f))];
  const names = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) names.add(m[1]!);
  }
  return names;
}

async function schemaFacts(): Promise<{ all: string[]; direct: Set<string>; fks: ForeignKey[] }> {
  const own = ownTables();
  const all = (await q<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t)
    .filter((t) => own.has(t));
  const direct = new Set((await q<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'workspace_id'`)).rows.map((r) => r.t));
  const fks = (await q<ForeignKey>(
    `SELECT cl.relname AS t, a.attname AS col, pc.relname AS parent, pa.attname AS "parentCol"
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class pc ON pc.oid = k.confrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = k.confkey[1]
      WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`)).rows;
  return { all, direct, fks };
}

/** SQL (with $1 = the workspace) that is true for the rows of `table` (aliased `alias`) belonging to it; null: no way found. */
function belongsToSql(table: string, alias: string, facts: { direct: Set<string>; fks: ForeignKey[] }, hop = 0): string | null {
  if (table === "workspaces") return `${alias}.id = $1`;
  if (facts.direct.has(table)) return `${alias}.workspace_id = $1`;
  if (TEXT_KEYED[table]) return TEXT_KEYED[table]!.replaceAll(" t.", ` ${alias}.`).replaceAll("(t.", `(${alias}.`);
  if (hop >= 3) return null;
  const via = facts.fks.filter((f) => f.t === table).map((f) => {
    const inner = belongsToSql(f.parent, `p${hop}`, facts, hop + 1);
    return inner && `EXISTS (SELECT 1 FROM "${f.parent}" p${hop} WHERE p${hop}."${f.parentCol}" = ${alias}."${f.col}" AND ${inner})`;
  }).filter((x): x is string => x !== null);
  return via.length ? `(${via.join(" OR ")})` : null;
}

/** Tables a workspace owns (by the rule above) in which `ws` has no row, and tables that name no owner and are not in UNSEEDED_TABLES. */
async function emptyTablesOf(ws: string): Promise<{ empty: string[]; ownerless: string[] }> {
  const facts = await schemaFacts();
  const empty: string[] = []; const ownerless: string[] = [];
  for (const table of facts.all) {
    if (table in UNSEEDED_TABLES) continue;
    const where = belongsToSql(table, "t", facts);
    if (!where) { ownerless.push(table); continue; }
    const row = await q(`SELECT 1 FROM "${table}" t WHERE ${where} LIMIT 1`, [ws]);
    if (!row.rows.length) empty.push(table);
  }
  return { empty, ownerless };
}

// ── Path params ────────────────────────────────────────────────────────────
// Value for each `:param`, about the group given. An UNKNOWN param throws: the completeness gate.
function fillParam(path: string, name: string, g: Group, w: World): string {
  const under = (prefix: string) => path.startsWith(prefix);
  switch (name) {
    case "id":
      if (under("/api/actors")) return path.endsWith("/invite") ? w.invite : w.member;
      if (under("/api/agent-sessions") || under("/api/mcp/sessions")) return g.session;
      if (under("/api/ai-suggestions")) return g.suggestion;
      if (under("/api/pointers")) return g.pointer;
      if (under("/api/backup/restore")) return w.upload;
      if (under("/api/external-calendars")) return w.calendar;
      if (under("/api/edges")) return g.edge;
      if (under("/api/tags")) return g.tag;
      if (under("/api/tasks")) return g.task;
      if (under("/api/rss/sources")) return w.feed;
      if (under("/api/rss/items")) return w.article;
      if (under("/api/spaces")) return w.space;
      if (under("/api/canvases") || under("/api/boards")) return g.canvas;
      if (under("/api/nodes")) return g.note;
      if (under("/api/inbox")) return g.event;
      return ZERO_UUID;
    case "nodeId": return g.note;
    case "tagId": return under("/api/review") ? w.reviewTag : g.tag;
    case "sourceId": return g.tag;
    case "actorId": return w.member;
    case "actor_id": return under("/api/agent-sessions/runners") ? w.agent : w.member;
    case "tokenId": return w.memberToken;
    case "event_id": case "root_event_id": case "eventId": return g.event;
    case "viewId": return under("/api/tags") ? g.tagView : g.noteView;
    case "key": return under("/api/me/prefs") ? "dayNoteParent" : w.attrKey;
    case "date": return w.day; // the day A's notes were made on, so the day lens has something of A's to leak
    case "filename": return w.media;
    case "blockId": return under("/api/review") ? w.block : `^${g.note.slice(0, 6)}`;
    case "ref": case "anchorId": return `^${g.note.slice(0, 6)}`;
    case "job": return w.job;
    case "versionId": case "hash": case "runId": case "rewindId": return ZERO_UUID;
    case "toolName": return "nosuchtool";
    case "kind": return "nosuchkind";
    case "decision": return "approve";
    case "action": return "retry";
    case "functionId": return "skills";
    default:
      throw new Error(
        `crossWorkspaceReadSweep: no value for :${name} in ${path} — extend fillParam() so the sweep can aim this route at A's objects`,
      );
  }
}

/** GET routes that answer 400 without a query string never reach their data: these get one that names A's objects. */
const QUERY: Record<string, (g: Group, w: World) => string> = {
  "/api/ai-suggestions": (g) => `node_id=${g.note}`,
  "/api/external-calendars/events": (_g, w) => `from=${w.day}&to=${w.day}`,
  "/api/agent-sessions": (g) => `node_id=${g.mention}`,
  "/api/backup/restore/:id/preview": (_g, w) => `space=${w.restoredSpace}&mode=merge`,
};

function fillPath(path: string, g: Group, method = "GET"): string {
  const filled = path.replace(/:([A-Za-z_]+)(?:\{[^}]*\})?/g, (_m, name: string) => fillParam(path, name, g, W));
  const query = method === "GET" ? QUERY[path]?.(g, W) : undefined; // keyed by the mounted pattern
  return query ? `${filled}?${query}` : filled;
}

// ── Requests ───────────────────────────────────────────────────────────────
type Caller = { ws: string; session: string | null };
async function call(who: Caller, method: string, path: string, body?: unknown): Promise<Response> {
  workspaceSwitch.ws = who.ws;
  sessionExternalId = who.session;
  try {
    const init: RequestInit = { method, headers: body === undefined ? {} : { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return await Promise.race([
      app.request(path, init),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error(`${method} ${path} did not answer within 15s`)), 15_000)),
    ]);
  } finally {
    sessionExternalId = null;
  }
}

/** The response as text, with what the REQUEST itself said removed when the answer is an error: a 404 that repeats
 *  the id the caller asked about leaks nothing, but the same id in a 2xx body is data. */
async function readable(res: Response, echoed: string[], scrubSuccess = false): Promise<string> {
  let text = Buffer.from(await res.arrayBuffer()).toString("latin1");
  if (res.status >= 400 || scrubSuccess) for (const e of echoed) text = text.split(e).join("");
  return text;
}

function leaked(text: string, needles: string[]): string[] {
  return needles.filter((n) => text.includes(n));
}

const echoedBy = (path: string) => decodeURIComponent(path).split(/[/?&=]/).filter((s) => s.length >= 12);

const MIN_ROUTES = 45;
const bodyFor = (g: Group): Record<string, unknown> => ({
  // Many plausible keys at once: a route reads the ones it knows. Everything names A's objects.
  title: `sweep-${STAMP}`, name: `sweep-${STAMP}`, markdown: `sweep-${STAMP}`, status: "done",
  note_id: g.note, node_id: g.note, target_id: g.child, parent_id: g.note, source_node_id: g.note, target_node_id: g.child,
  edge_type: "sweep_edge", tag_id: g.tag, tag_ids: [g.tag], ids: [g.note], item_ids: "all", event_ids: [g.event],
  expected_ids: [g.note], to_actor_id: W.member, confirm_name: "x", permission: "edit", access: "read", value: "x", value_type: "text",
  type: "human", fields: [], decision: "approve", x: 1, y: 1, text: "x", t: new Date(0).toISOString(), restore_ids: [g.note], undelete_ids: [], delete_ids: [g.note],
});

describe.skipIf(!enabled)("cross-workspace read sweep (real app, DB)", { timeout: SWEEP_TIMEOUT_MS }, () => {
  let gets: MountedRoute[] = [];
  let writes: MountedRoute[] = [];
  let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;

  beforeAll(async () => {
    // The static export asks the frontend for each page; a stand-in answers for whichever workspace is current.
    renderer = await startFakeRenderer(() => workspaceSwitch.ws);
    const [a, b] = [await freshWorkspace("sweepA"), await freshWorkspace("sweepB")];
    for (const side of [a, b]) await setModulesOn(side.ws, null);
    const c = await freshWorkspace("sweepC");
    await setModulesOn(c.ws, null);
    const C: Side = { ws: c.ws, owner: c.actor, ownerExternalId: await externalId(c.actor, "ownerC") };
    const A: Side = { ws: a.ws, owner: a.actor, ownerExternalId: await externalId(a.actor, "ownerA") };
    const B: Side = { ws: b.ws, owner: b.actor, ownerExternalId: await externalId(b.actor, "ownerB") };
    // Something in B too, so "B gets its own data" is visibly different from "B gets nothing".
    await createNote({ actor: B.owner, workspaceId: B.ws, title: `sweepBnote${STAMP}`, markdown: "B body", event: { uiContext: "test.sweep" } });

    const restrictedSpace = await adminOnlySpace(A.ws, canary("RestrictedSpace"), [A.owner.id]);
    const open = await buildGroup(A, "open", null);
    const restricted = await buildGroup(A, "restricted", restrictedSpace);
    const space = restrictedSpace;

    // media
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer();
    const stored = await storeMedia(png, ".png", { actor: A.owner, workspaceId: A.ws, origin: "upload" });
    if (!stored.ok) throw new Error(`media: ${stored.reason}`);

    // RSS source and one article
    const feed = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url, created_by_actor_id)
       SELECT $1, s.id, $2, $3, $4 FROM spaces s WHERE s.workspace_id = $1 AND s.is_default RETURNING id::text`,
      [A.ws, canary("Feed"), `https://feed.test/${canary("feedurl")}.xml`, A.owner.id])).rows[0]!.id;
    const article = (await seedQ<{ id: string }>(
      `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, body, published_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::text`,
      [A.ws, feed, `guid-${STAMP}`, canary("Article"), canary("ArticleBody")])).rows[0]!.id;

    // publish settings (site config note)
    await setSiteConfig(A.ws, { brand: canary("Brand"), tagline: canary("Tagline") });

    // A's lowest member: view on the default space, nothing in the restricted one
    const member = await persistActor(A.ws, { id: "", name: canary("Member"), type: "human", role: "viewer" });
    const memberExternalId = await externalId(member, "memberA");
    const memberToken = (await createToken(member.id, { name: canary("Token"), access: "read" })).id;
    await awaitAllDispatchers();

    // ── the kinds the first version left empty ──
    workspaceSwitch.ws = A.ws; // services that ask "which workspace?" (grade, review settings…) answer A
    const agent = await persistActor(A.ws, {
      id: "", name: canary("Agent"), type: "agent", role: "editor",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    await joinDefaultSpace(A.ws, agent.id);
    // an agent session needs a space that lets external AI in (the default space keeps it out until the owner says so)
    await seedQ(`UPDATE spaces SET capabilities = capabilities || '{"external_ai": true}'::jsonb WHERE workspace_id = $1 AND is_default`, [A.ws]);
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [restrictedSpace, agent.id]);
    const handle = `a${randomBytes(3).toString("hex")}`;
    await configureRunner(A.ws, agent.id, { handle }, { actor: A.owner });
    await setRunnerEnabled(A.ws, agent.id, true, { actor: A.owner });
    // (a note with no space lands in its author's personal space, which the agent is not in: the mention notes name theirs)
    const defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [A.ws])).rows[0]!.id;
    for (const [g, label, spaceId] of [[open, "open", defaultSpace], [restricted, "restricted", restrictedSpace]] as const) {
      await buildAgentThings(A, g, label, spaceId, { actor: agent, handle });
    }

    // review: a tag that holds the limits, both groups' notes as cards, a graded card, the owner's own settings for the tag
    const reviewTag = (await seedClassTag(A.ws, { name: canary("ReviewTag") })).tagId;
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [reviewTag]); // where the daily limits are read from
    for (const g of [open, restricted]) {
      await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2) ON CONFLICT DO NOTHING`, [A.ws, g.note]);
      // what migration 201 records of an id it changed (read only by the restore and served-site code, never by a route)
      await seedQ(`INSERT INTO id_rewrites (old_id, new_id, workspace_id, purpose) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'probe')`, [A.ws]);
      await grade(A.owner, g.note, 3);
    }
    await replaceSettings(A.owner, reviewTag, { maximum_interval_days: 7 });
    // the join record of a database that was filled from a snapshot (migration 204; no route reads it)
    await seedQ(`INSERT INTO sync_join (workspace_id, source_node, cut_seq, state) VALUES ($1, 'sweep-probe-node', 0, 'done')`, [A.ws]);

    // a day note for the day A's notes were made on (the day lens lists what happened that day)
    const madeAt = (await q<{ t: Date }>(`SELECT created_at AS t FROM content_nodes WHERE id = $1`, [open.note])).rows[0]!.t;
    const day = localDayId(madeAt);
    await createNote({ actor: A.owner, workspaceId: A.ws, title: day, slug: day, markdown: `${canary("DayNote")} wrote this today`, event: { uiContext: "test.sweep" } });

    // a pending invitation (a person with no account yet) and a push subscription of the owner's device
    const inviteEmail = `${canary("Invitee").toLowerCase()}@sweep.test`;
    const invited = await createActor(A.owner, async () => ({ type: "human", name: canary("InviteeName"), email: inviteEmail }) as never) as { id: string; invite_url?: string };
    await saveSubscription(A.owner, A.ws, {
      endpoint: `https://fcm.googleapis.com/fcm/send/${canary("PushEndpoint")}`, p256dh: canary("P256dh"), auth: canary("PushAuth"),
    }, `Mozilla/5.0 ${canary("Browser")}`);

    // an external calendar of the owner's, with one fetched event (the address is stored sealed; the fetch itself is replaced by its outcome)
    process.env.ONDEN_SECRET_KEY ??= "ab".repeat(32);
    const calendarId = randomUUID();
    await addCalendar(A.ws, A.owner, { id: calendarId, name: canary("Calendar"), color: "#336699", href: `https://calendar.test/${canary("calurl")}.ics`, host: "calendar.test" });
    await saveFetchResult(A.ws, calendarId, { ok: true, instances: [{
      key: `${canary("CalEvent")}-1`, title: canary("CalEvent"), location: canary("CalPlace"), description: canary("CalDescription"),
      allDay: false, startsAt: `${day}T10:00:00Z`, endsAt: `${day}T11:00:00Z`, startDate: null, endDate: null,
    }] });

    // backups: a restore that finished (its job stays), and a second upload still waiting (its preview is a read)
    const donor = await freshWorkspace("sweepD");
    await createNote({ actor: donor.actor, workspaceId: donor.ws, title: canary("BackupNote"), markdown: canary("BackupBody"), event: { uiContext: "test.sweep" } });
    workspaceSwitch.ws = donor.ws;
    const zip = await collect(await buildFullBackup(donor.actor, donor.ws));
    workspaceSwitch.ws = A.ws;
    const restoredSpace = await adminOnlySpace(A.ws, canary("RestoredSpace"), [A.owner.id]);
    const stagedForJob = await stageBackupUpload(A.owner.id, Readable.from([zip]), zip.length);
    let job = (await startRestoreJob(A.owner, A.ws, stagedForJob.uploadId, restoredSpace, "empty")).job;
    for (let waited = 0; job.status === "running"; waited += 50) {
      if (waited > 60_000) throw new Error("sweep: the restore job did not finish");
      await new Promise((r) => setTimeout(r, 50));
      job = (await getRestoreJob(A.owner.id, job.id))!;
    }
    if (job.status !== "done") throw new Error(`sweep: the restore job ${job.status}: ${job.error}`);
    const upload = (await stageBackupUpload(A.owner.id, Readable.from([zip]), zip.length)).uploadId;
    await awaitAllDispatchers();

    // ── the rest of the tables a workspace owns: the owner's own settings, a paragraph with a tag and a link to it, the
    //    published snapshot, focus, reading and feed state, and the bookkeeping rows the product writes behind a feature ──
    await writePref(A.owner, "dayNoteParent", open.note);
    // a drawing big enough to be stored as chunks (services/inkChunks.ts): its chunks and its manifest are A's rows
    const bigStrokes = Array.from({ length: Math.ceil(INK_CHUNK_THRESHOLD / 60) }, (_, i) => ({ id: `${canary("InkStroke")}-${i}`, points: [[i, i, 0.5], [i + 1, i + 2, 0.5]], color: "#000000", size: 2, toolId: "pen" }));
    await setNodeAttribute({ workspaceId: A.ws, actor: A.owner, nodeId: open.note, attribute: { key: "ink_data", value: JSON.stringify({ version: 1, strokes: bigStrokes, erased: {}, page: { width: 1000 } }), value_type: "text" } });
    const apiKey = `sk-${canary("ApiKey")}`;
    await addCredential(A.ws, { label: canary("Credential"), apiKey, baseUrl: "https://api.example.test", protocol: "v1_messages" }, { actor: A.owner });
    await seedQ(
      `INSERT INTO ai_suggestions (workspace_id, target_type, target_id, suggestion_type, payload, status, reasoning)
       VALUES ($1, 'node', $2, 'summary', $3::jsonb, 'pending', $4)`,
      [A.ws, open.note, JSON.stringify({ summary: canary("LegacySummary") }), canary("LegacyReasoning")]);
    // a paragraph that is a review card and carries a topic tag ({…} at its end makes a block node, its tag row and its reference), and a link written in the citing note to a part of the note
    const blockNote = (await createNote({
      actor: A.owner, workspaceId: A.ws, title: canary("BlockNote"), markdown: `${canary("BlockPara")} a paragraph on its own {${canary("ReviewTag")}, ${canary("BlockTopic")}}\n\nsecond ${canary("BlockPara2")}`,
      event: { uiContext: "test.sweep" },
    })).node.id as string;
    const blockMarkdown = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [blockNote])).rows[0]!.markdown;
    await createBlockLink({ workspaceId: A.ws, actor: A.owner, targetNoteId: blockNote, sourceNoteId: open.note, at: blockMarkdown.indexOf("second"), seenText: `second ${canary("BlockPara2")}` });
    const block = (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND note_id = $2 ORDER BY created_at LIMIT 1`, [A.ws, blockNote])).rows[0]?.id ?? ZERO_UUID;
    await grade(A.owner, blockNote, 3, new Date(), { kind: "block", id: block }).catch(() => undefined);
    // history of boards and canvases: what the product keeps so a conversion, fold or unparent can be undone
    const attr = (await q<{ id: string }>(`SELECT id::text FROM node_attributes WHERE workspace_id = $1 LIMIT 1`, [A.ws])).rows[0]!.id;
    await seedQ(`INSERT INTO canvas_note_conversions (node_id, workspace_id) VALUES ($1, $2)`, [open.canvas, A.ws]);
    await seedQ(`INSERT INTO board_copy_unparents (node_id, copy_id, workspace_id, prev_parent_id, prev_sort_order, event_id) VALUES ($1, $2, $3, $4, 0, $5)`, [open.canvas, open.child, A.ws, open.note, open.event]);
    await seedQ(`INSERT INTO board_copy_folds (node_id, folded_into, workspace_id, b_cards, moved_card_ids, dropped_cards, delete_event_id) VALUES ($1, $2, $3, '[]', '{}', '[]', $4)`, [open.canvas, restricted.canvas, A.ws, open.event]);
    await seedQ(
      `INSERT INTO board_ink_moves (node_id, workspace_id, action, reason, suggested, signals, board_ink_attribute_id, value_hash) VALUES ($1, $2, 'moved', 'ambiguous', 'unknown', '{}', $3, $4)`,
      [open.canvas, A.ws, attr, randomBytes(8).toString("hex")]);
    await seedQ(`INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by, note) VALUES ($1, $2, 'approved', $3, $4)`, [open.event, A.ws, A.owner.id, canary("ReviewNote")]);
    await startFocus(A.owner, { task_id: open.task });
    await seedQ(`INSERT INTO imported_media (workspace_id, actor_id, content_hash, extension, filename) VALUES ($1, $2, $3, '.png', $4)`, [A.ws, A.owner.id, randomBytes(32).toString("hex"), stored.filename]);
    await recordMemberRemoval(A.ws, canary("RemovedMember"));
    await seedQ(`INSERT INTO node_embeddings (node_id, workspace_id, model, content_hash, embedding) VALUES ($1, $2, 'sweep', $3, array_fill(0.01::real, ARRAY[384])::vector)`, [open.note, A.ws, randomBytes(8).toString("hex")]);
    // A published snapshot of one open note (what the owner chose to publish), written by hand: publishing queues a site build
    // in the outbox, which would run while the sweep switches workspaces. The static copy is made HERE instead, once, so that
    // /api/site/search.idx/* finds it stored and starts no background build in the middle of the sweep.
    const snapshotPayload = { nodes: [{ id: open.note, title: canary("openTitle"), slug: open.slug, markdown: `${canary("openBody")} ![](/api/media/${stored.filename})` }] };
    const snapshotId = (await seedQ<{ id: string }>(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1, $2, $3, 1, $4::jsonb, '/site/') RETURNING id::text`,
      [A.ws, canary("SnapshotTitle"), open.note, JSON.stringify(snapshotPayload)])).rows[0]!.id;
    await recordSnapshotMedia(snapshotId, snapshotPayload);
    await ensureSiteBundle({ workspaceId: A.ws });
    await seedQ(`INSERT INTO push_reminder_sent (task_id, moment) VALUES ($1, $2)`, [open.task, `${day}T09:00`]);
    await mutatePersonal({ actor: A.owner, workspaceId: A.ws, apply: () => markSeen([article], A.owner.id, true) });
    await muteKeyword(A.owner, A.ws, canary("MutedWord"));
    await awaitAllDispatchers();

    const harvested = await harvestNeedles(A.ws);
    const canaries = [`SWEEPopen`, `SWEEPrestricted`, canary("Feed"), canary("feedurl"), canary("Article"), canary("Brand"), canary("Tagline"), canary("Member"), canary("Token"), canary("RestrictedSpace"),
      ...["Agent", "ReviewTag", "DayNote", "Invitee", "PushEndpoint", "P256dh", "PushAuth", "Browser", "Calendar", "calurl", "CalEvent", "CalPlace", "CalDescription", "BackupNote", "BackupBody", "RestoredSpace", "Credential", "ApiKey", "LegacySummary", "LegacyReasoning", "BlockNote", "BlockPara", "ReviewNote", "RemovedMember", "MutedWord", "SnapshotTitle"].map(canary),
      inviteEmail, invited.invite_url ?? ""].filter((n) => n.length >= 12);
    const attrKey = "sweepattr";
    const restrictedIds = [...await harvestRestricted(A.ws, restrictedSpace), ...await harvestRestricted(A.ws, restoredSpace)];
    W = {
      A, B, C, open, restricted, restoredSpace, agent: agent.id, invite: invited.id, calendar: calendarId, upload, job: job.id, reviewTag, day, block, member: member.id, memberExternalId, memberToken, media: stored.filename, feed, article, space, restrictedSpace, attrKey,
      allNeedles: [...new Set([...canaries, ...harvested, stored.filename])],
      // Tags are workspace-wide (not in a space), so their names are not secret from a member.
      restrictedNeedles: ["Title", "Body", "Para", "Item", "AttrValue", "Child", "ChildBody", "Task", "TaskBody", "Canvas", "NoteView",
        "Pointer", "MentionNote", "AgentPrompt", "AgentThought", "AgentMessage", "Proposed", "SuggestComment"]
        .map((what) => canary(`restricted${what}`))
        // What belongs to A's owner alone or to a space the member is not in: the owner's calendar and device, the invitation, the restored backup.
        .concat(canary("RestrictedSpace"), canary("RestoredSpace"), canary("BackupNote"), canary("BackupBody"), canary("Calendar"), canary("CalEvent"), canary("PushEndpoint"), canary("PushAuth"), canary("Credential"), canary("ApiKey"), canary("RemovedMember"), canary("MutedWord"), inviteEmail, restrictedIds),
    };
    gets = mountedRoutes(app, (m) => m === "GET");
    writes = mountedRoutes(app, (m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m));
  }, 120_000);

  afterAll(async () => { workspaceSwitch.ws = ""; await renderer?.close(); });

  it("the inventory is plausible and every parameter can be filled (completeness gate)", () => {
    expect(gets.length).toBeGreaterThanOrEqual(MIN_ROUTES);
    for (const sentinel of ["/health", "/api/site", "/api/bootstrap", "/api/sync", "/api/nodes/:id/attributes", "/api/tags"]) {
      expect(gets.map((r) => r.path), `sentinel ${sentinel} missing`).toContain(sentinel);
    }
    const unfillable: string[] = [];
    for (const r of [...gets, ...writes]) {
      if (SKIP_ALL(r.path)) continue;
      try { fillPath(r.path, W.open); } catch (e) { unfillable.push(`${r.method} ${r.path}: ${(e as Error).message}`); }
    }
    expect(unfillable, unfillable.join("\n")).toEqual([]);
    // every public path on the allowlist still names something mounted
    for (const rule of PUBLIC) expect(gets.some((r) => rule.test(r.path)), `public allowlist entry is dead: ${rule.reason}`).toBe(true);
  });

  it("sanity: the world is what the sweep assumes (A's owner reads A's note, B's owner does not)", async () => {
    const own = await call({ ws: W.A.ws, session: W.A.ownerExternalId }, "GET", `/api/nodes/${W.open.note}/versions`);
    expect(own.status).toBe(200);
    const other = await call({ ws: W.B.ws, session: W.B.ownerExternalId }, "GET", `/api/nodes/${W.open.note}/versions`);
    expect([403, 404]).toContain(other.status);
    const list = await call({ ws: W.A.ws, session: W.A.ownerExternalId }, "GET", "/api/bootstrap");
    expect(await list.text()).toContain(canary("openTitle"));
  });


  it("A holds at least one row in every table a workspace owns (a new table the sweep does not seed fails here, by name)", async () => {
    const { empty, ownerless } = await emptyTablesOf(W.A.ws);
    expect(ownerless, `tables that name no workspace and are not in UNSEEDED_TABLES (give them an owner column, or a reason): ${ownerless.join(", ")}`).toEqual([]);
    expect(empty, `A has no row in: ${empty.join(", ")} — seed it in beforeAll, or (if it cannot be) list it in UNSEEDED_TABLES with the reason`).toEqual([]);
    for (const table of Object.keys(UNSEEDED_TABLES)) {
      expect((await schemaFacts()).all, `UNSEEDED_TABLES names ${table}, which no longer exists`).toContain(table);
    }
  });


  // The seeded kinds are only worth something if a route the sweep calls serves them. A's owner asks each of these (the same
  // pattern, the same fillPath the sweep uses for B) and must get 200 with the seed's own canary in the body; so when the
  // sweep sends B at that route it is aimed at real data, not at an empty answer.
  const REACHED_BY: Array<{ kind: string; route: string; needle: (w: World) => string }> = [
    { kind: "pointer", route: "/api/bootstrap", needle: () => canary("openPointer") },
    { kind: "AI suggestion (pending)", route: "/api/ai-suggestions", needle: () => canary("openProposed") },
    { kind: "agent session and its log", route: "/api/agent-sessions/:id", needle: () => canary("openAgentThought") },
    { kind: "agent sessions of a note", route: "/api/agent-sessions", needle: () => W.open.session },
    { kind: "external calendar", route: "/api/external-calendars", needle: () => canary("Calendar") },
    { kind: "external calendar event", route: "/api/external-calendars/events", needle: () => canary("CalEvent") },
    { kind: "backup restore preview", route: "/api/backup/restore/:id/preview", needle: () => canary("BackupNote") },
    { kind: "backup restore job", route: "/api/backup/restore/jobs/:job", needle: (w) => w.job },
    { kind: "pending invitation", route: "/api/actors", needle: () => canary("InviteeName") },
    { kind: "review settings", route: "/api/review/settings/:tagId", needle: () => "maximum_interval_days" },
    { kind: "review progress (a graded card)", route: "/api/review/:nodeId/state", needle: () => "introduced_at" },
    { kind: "review block card", route: "/api/review/blocks/:blockId/state", needle: (w) => w.block },
    { kind: "day note and day lens", route: "/api/day/:date/lens", needle: () => canary("openTitle") },
    { kind: "account preference", route: "/api/me/prefs/:key", needle: () => W.open.note },
    { kind: "AI credential", route: "/api/ai/credentials", needle: () => canary("Credential") },
    { kind: "publish snapshot", route: "/api/snapshots", needle: () => canary("SnapshotTitle") },
    { kind: "feed mute", route: "/api/rss/mutes", needle: () => canary("MutedWord") },
    { kind: "focus session", route: "/api/tasks/focus", needle: () => W.open.task },
  ];
  it("every seeded kind is served by a GET route the sweep calls (A's owner reads it back)", async () => {
    const failures: string[] = [];
    const routes = new Set(gets.map((r) => r.path));
    for (const r of REACHED_BY) {
      if (!routes.has(r.route)) { failures.push(`${r.kind}: no mounted GET ${r.route}`); continue; }
      const res = await call({ ws: W.A.ws, session: W.A.ownerExternalId }, "GET", fillPath(r.route, W.open));
      const text = await res.text();
      if (res.status !== 200) failures.push(`${r.kind}: GET ${r.route} answered ${res.status} to A's owner: ${text.slice(0, 120)}`);
      else if (!text.includes(r.needle(W))) failures.push(`${r.kind}: GET ${r.route} answered 200 without ${r.needle(W).slice(0, 40)}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("anonymous → 401 everywhere except the public allowlist (which must not 5xx or show A's restricted space)", async () => {
    const failures: string[] = [];
    for (const r of gets) {
      if (SKIP_ALL(r.path)) continue;
      const path = fillPath(r.path, W.open);
      const res = await call({ ws: W.A.ws, session: null }, "GET", path);
      if (isPublic(r.path)) {
        if (res.status === 401) failures.push(`${r.path}: public route answered 401`);
        if (res.status >= 500) failures.push(`${r.path}: public route answered ${res.status}`);
        const hit = leaked(await readable(res, echoedBy(path)), W.restrictedNeedles);
        if (hit.length) failures.push(`${r.path}: public route leaked restricted ${hit.join(", ")}`);
      } else if (res.status !== 401) failures.push(`${r.path}: anonymous got ${res.status}, expected 401`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("B's owner: no 5xx on any GET, and nothing of A in any body (A's open and restricted objects both aimed at)", async () => {
    const failures: string[] = [];
    const B = { ws: W.B.ws, session: W.B.ownerExternalId };
    for (const r of gets) {
      if (SKIP_AUTHED(r.path)) continue;
      for (const g of [W.open, W.restricted]) {
        const path = fillPath(r.path, g);
        const res = await call(B, "GET", path);
        if (res.status >= 500) failures.push(`GET ${path}: B's owner got ${res.status}`);
        const hit = leaked(await readable(res, echoedBy(path)), W.allNeedles);
        if (hit.length) failures.push(`GET ${r.path}: B's owner (${res.status}) saw A's ${hit.map((h) => (h.length > 24 ? `${h.slice(0, 24)}…` : h)).join(", ")}`);
        if (g === W.open && r.path.startsWith("/api/media/") && res.status === 200) failures.push(`GET ${r.path}: B's owner was served A's media file`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("A's lowest member (view on the default space): no 5xx, nothing of A's restricted space", async () => {
    const failures: string[] = [];
    const member = { ws: W.A.ws, session: W.memberExternalId };
    for (const r of gets) {
      if (SKIP_AUTHED(r.path)) continue;
      for (const g of [W.restricted, W.open]) {
        const path = fillPath(r.path, g);
        const res = await call(member, "GET", path);
        if (res.status >= 500) failures.push(`GET ${path}: A's member got ${res.status}`);
        const hit = leaked(await readable(res, echoedBy(path)), W.restrictedNeedles);
        if (hit.length) failures.push(`GET ${r.path}: A's member (${res.status}) saw restricted ${hit.join(", ")}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("/api/bootstrap and /api/sync answer B with B's own data, whatever workspace the request tries to name", async () => {
    const failures: string[] = [];
    const B = { ws: W.B.ws, session: W.B.ownerExternalId };
    const tries = ["", `?workspace=${W.A.ws}`, `?workspace_id=${W.A.ws}`, `?workspaceId=${W.A.ws}`, `?space_id=${W.restrictedSpace}`, `?since=0&workspace_id=${W.A.ws}`];
    for (const base of ["/api/bootstrap", "/api/sync"]) {
      for (const qs of tries) {
        for (const headers of [undefined, { "x-workspace-id": W.A.ws, "x-onden-workspace": W.A.ws, "x-workspace": W.A.ws }]) {
          workspaceSwitch.ws = B.ws; sessionExternalId = B.session;
          let res: Response;
          try { res = await app.request(`${base}${qs}`, { headers }); } finally { sessionExternalId = null; }
          const text = await res.text();
          if (res.status >= 500) failures.push(`${base}${qs}: ${res.status}`);
          const hit = leaked(text, W.allNeedles);
          if (hit.length) failures.push(`${base}${qs}${headers ? " + headers" : ""}: leaked ${hit.slice(0, 3).join(", ")}`);
          if (!qs && !headers) expect(text, `${base} should hold B's own note`).toContain(`sweepBnote${STAMP}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("an unrelated owner (workspace C) writing at A's ids: no 5xx, and A's rows are unchanged afterwards", async () => {
    const failures: string[] = [];
    const B = { ws: W.C.ws, session: W.C.ownerExternalId };
    const before = await snapshot(W.A.ws);
    for (const r of writes) {
      if (SKIP_ALL(r.path)) continue;
      for (const g of [W.open, W.restricted]) {
        const path = fillPath(r.path, g);
        const res = await call(B, r.method, path, bodyFor(g));
        if (res.status >= 500) failures.push(`${r.method} ${path}: got ${res.status}`);
        // The answer may repeat what the request itself carried (ids in the path or body), which is not a read.
        const text = await readable(res, [...echoedBy(path), ...W.allNeedles.filter((n) => JSON.stringify(bodyFor(g)).includes(n))], true);
        const hit = leaked(text, W.allNeedles);
        if (hit.length) failures.push(`${r.method} ${r.path}: (${res.status}) answered with A's ${hit.slice(0, 3).join(", ")} :: ${text.slice(0, 300)}`);
        await awaitAllDispatchers();
        const changed = diffSnapshots(before, await snapshot(W.A.ws));
        if (changed.length) {
          failures.push(`${r.method} ${r.path}: B's owner changed A's ${changed.join(", ")} (status ${res.status})`);
          before.clear(); for (const [k, v] of await snapshot(W.A.ws)) before.set(k, v); // report each route once
        }
      }
    }
    // Nothing C owns may now point at an object of A (a tag under A's note, a link to A's task…).
    const ids = W.allNeedles.filter((n) => /^[0-9a-f-]{36}$/.test(n) && n !== W.A.ws);
    const pointing = await tablesMentioning(W.C.ws, ids);
    if (pointing.length) failures.push(`C's rows in ${pointing.join(", ")} reference A's objects`);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

/** Ids and slugs of everything in A's restricted space (the open group's are not secret from A's member). */
async function harvestRestricted(ws: string, spaceId: string): Promise<string[]> {
  const ids = new Set<string>([spaceId]);
  const nodes = await q<{ id: string; slug: string | null }>(`SELECT id::text, slug FROM content_nodes WHERE workspace_id = $1 AND space_id = $2`, [ws, spaceId]);
  for (const n of nodes.rows) { ids.add(n.id); if (n.slug) ids.add(n.slug); }
  const edges = await q<{ id: string }>(
    `SELECT e.id::text FROM node_edges e JOIN content_nodes n ON n.id = e.source_node_id WHERE e.workspace_id = $1 AND n.space_id = $2`, [ws, spaceId]);
  for (const e of edges.rows) ids.add(e.id);
  return [...ids].filter((s) => s.length >= 12);
}
