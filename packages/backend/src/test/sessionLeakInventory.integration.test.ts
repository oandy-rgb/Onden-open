// What a participant limited to one space is told about another (docs/architecture/proposals/sessions-core-2026-11-17.md §A, risk 1 of
// roles-spaces-sessions-2026-11-15.md §8).
//
// Space B (not A) holds one distinctive name per KIND of thing a space can hold. Every mounted GET route of the real assembled app, and the reads that are
// POSTs, is called twice: as a plain MEMBER of A and as a temporary SESSION opened on A, each time with no ids and aimed at B's own ids; the answers are
// searched for B's names. The routes are read from the router (mountedRoutes), so a route added later is swept without anyone remembering it.
//
//   member   tag definitions are the workspace's shared vocabulary: the names of the tags used only in B ARE told to a member (unchanged: spaces.md).
//            Asserted as-is, so a change in what members see is a decision, not a side effect. (It was an `it.fails` pin while sessions did not exist:
//            commit "Pin the reads a space-limited participant would inherit".)
//   session  nothing of B is told: not a note, a tag, a field, a property, a space, a person, an AI. This is the step that flipped the pin.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, event } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { mountedRoutes } from "./helpers/appRoutes.js";
import { newNote, newPerson, newWorkspace, openAs } from "./helpers/sessionWorld.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { storeMedia } from "../services/media.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { createHash } from "node:crypto";
import sharp from "sharp";

registerShippedModules();

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Member", email: `${signedInAs}@probe.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

const tag = randomUUID().slice(0, 8);
/** One distinctive word per kind of thing space B (or the owner's personal space) holds. */
const NAME = {
  note: `zznoteB${tag}`,         // a note title in B (control: the read gate already closes this one)
  noteBody: `zzbodyB${tag}`,     // the body of that note
  tag: `zztagB${tag}`,           // a tag definition applied only to notes of B
  field: `zzfieldB${tag}`,       // a field defined on that tag
  property: `zzpropB${tag}`,     // a property key written only on a note of B
  space: `zzspaceB${tag}`,       // the name of space B
  person: `zzpersonB${tag}`,     // a person who is a member of B only
  agent: `zzagentB${tag}`,       // an AI who is a member of B only
  personalNote: `zzmineB${tag}`, // a note in the owner's personal space
  personalPref: `zzprefOwner${tag}`, // a preference of the owner (personal data)
  deletedNote: `zzbinB${tag}`,   // a note of B that is in the trash
  view: `zzviewB${tag}`,         // a saved view on a note and on a tag of B
  board: `zzboardB${tag}`,       // a whiteboard of B
  article: `zzarticleB${tag}`,   // an RSS article of a feed in B
  drawing: `zzdrawB${tag}`,      // the id of a stroke in a drawing of B (the drawing is JSON text)
  media: `zzmediaB${tag}`,       // the text of a note of B that embeds a stored file
} as const;
/** Names the participant MAY be told (controls: a probe that hid everything would pass for the wrong reason). */
const VISIBLE = {
  noteA: `zznoteA${tag}`,        // a note of space A
  tagA: `zztagA${tag}`,          // a tag used in A
  tagShared: `zztagBoth${tag}`,  // a tag used in A and in B: its name says nothing the participant could not already know
  tagUnused: `zztagFree${tag}`,  // a tag nobody uses names no space
  tagParent: `zztagParent${tag}`, // a tag used only in B whose child tag is used in A: the child's path names it
} as const;

let memberExt = "", ownerExt = "";
let spaceA = "", spaceB = "";
let sessionCredential = "";
const ids: Record<string, string> = {};
/** Real things of space A (what a valid probe aims at), by kind. */
const idsA: Record<string, string> = {};
type Init = { method?: string; body?: unknown };

type Viewer = "member" | "session";
async function asViewer(viewer: Viewer, path: string, init: Init = {}) {
  signedInAs = viewer === "member" ? memberExt : null;
  try {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { ...(viewer === "session" ? { authorization: `Bearer ${sessionCredential}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  } finally { signedInAs = null; }
}

/** A write through the real routes as the owner (the probe world is built with the same doors a person uses). */
async function asOwner(path: string, init: Init = {}) {
  signedInAs = ownerExt;
  try {
    const res = await app.request(path, { method: init.method ?? "GET", headers: init.body ? { "content-type": "application/json" } : {}, body: init.body ? JSON.stringify(init.body) : undefined });
    return { status: res.status, text: await res.text() };
  } finally { signedInAs = null; }
}

/** The routes whose probe needs more than one id of a note, tag or space (a saved view, a card, a file…): the real things of space A and of space B they take, and the ids to mask when the
 *  answers for B's thing and for a thing that does not exist are compared. Filled by the seeds in beforeAll. */
type Aimed = { path: string; ids: string[] };
const PROBES: Record<string, (thing: "A" | "B" | "none") => Aimed> = {};
const one = (path: (id: string) => string, pick: (thing: "A" | "B") => string) => (thing: "A" | "B" | "none"): Aimed => {
  const id = thing === "none" ? randomUUID() : pick(thing);
  return { path: path(id), ids: [id] };
};

/** The id a route's `:param` is aimed at: the thing of space B the route is about (a probe by id must be refused). */
function aimedAt(path: string, thing: "B" | "A" | "none" = "B"): string {
  if (thing === "none") return randomUUID();
  const of = thing === "B" ? { space: spaceB, tag: ids.tag!, actor: ids.person!, note: ids.note! } : { space: spaceA, tag: idsA.tag!, actor: idsA.member!, note: idsA.note! };
  if (path.startsWith("/api/spaces")) return of.space;
  if (path.startsWith("/api/tags")) return of.tag;
  if (path.startsWith("/api/actors")) return of.actor;
  return of.note;
}
/** Fill a route's parameters: by default every one with the id of the thing the route is about; the few that are not an id of a note, tag or space by what they are. */
const filled = (path: string, thing: "B" | "A" | "none" = "B") => path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) => {
  if (thing === "A" && name === "event_id") return idsA.event ?? aimedAt(path, thing);
  if (thing === "A" && name === "date") return new Date().toISOString().slice(0, 10);
  if (name === "key" && path.startsWith("/api/me/prefs")) return "nav";
  return aimedAt(path, thing);
});
/** Query strings added to every route: the common ways a read takes a search word or a range. */
const QUERIES = ["", `?q=${NAME.note}&query=${NAME.note}&search=${NAME.note}&limit=500&since=0&all=1`];

type Hit = { route: string; word: string };
const probed: Record<Viewer, Array<{ route: string; status: number }>> = { member: [], session: [] };
const leaks: Record<Viewer, Hit[]> = { member: [], session: [] };
const seenBy: Record<Viewer, string> = { member: "", session: "" }; // every body the viewer got, for the controls

async function sweep(viewer: Viewer): Promise<void> {
  const routes = mountedRoutes(app, (m) => m === "GET");
  const record = (route: string, res: { status: number; text: string }) => {
    probed[viewer].push({ route, status: res.status });
    seenBy[viewer] += res.text;
    for (const word of Object.values(NAME)) if (res.text.includes(word)) leaks[viewer].push({ route, word });
  };
  for (const r of routes) {
    if (/\/stream$/.test(r.path)) continue; // a server-sent-event stream never ends: not a read of a body
    for (const query of QUERIES) record(`GET ${r.path}${query ? " (+search)" : ""}`, await asViewer(viewer, filled(r.path) + query));
  }
  // Reads that are POSTs: the sync delta and the node query (the body names what to ask for).
  for (const [route, path, body] of [
    ["POST /api/sync", "/api/sync", { since: 0, known: [] }],
    ["POST /api/query", "/api/query", { limit: 500 }],
    ["POST /api/query (+search)", "/api/query", { q: NAME.note, limit: 500 }],
  ] as const) record(route, await asViewer(viewer, path, { method: "POST", body }));
}

/** Per route with a :param: what each got when aimed at a real thing of A (valid probe) and what the session got for B's thing against a made-up id (must be the same). */
const paramRoutes: Array<{ route: string; member: number; session: number; sessionBody: string }> = [];
const distinguishable: string[] = [];
async function probeWithIds(): Promise<void> {
  for (const r of mountedRoutes(app, (m) => m === "GET")) {
    if (/\/stream$/.test(r.path) || !/:[A-Za-z_]/.test(r.path)) continue;
    const route = `GET ${r.path}`;
    const aimed = (thing: "A" | "B" | "none"): Aimed => PROBES[r.path]?.(thing) ?? { path: thing === "A" ? filled(r.path, "A") : r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, aimedAt(r.path, thing)), ids: [aimedAt(r.path, thing === "A" ? "A" : thing)] };
    const member = await asViewer("member", aimed("A").path);
    const session = await asViewer("session", aimed("A").path);
    paramRoutes.push({ route, member: member.status, session: session.status, sessionBody: session.text });
    // B's real thing against a thing that does not exist: the session must not be able to tell them apart (status and text, the ids themselves masked)
    const mask = (text: string, ids: string[]) => ids.reduce((t, id) => t.split(id).join("<id>"), text);
    const [b, none0] = [aimed("B"), aimed("none")];
    const realB = await asViewer("session", b.path);
    const none = await asViewer("session", none0.path);
    if (realB.status !== none.status || mask(realB.text, b.ids) !== mask(none.text, none0.ids)) distinguishable.push(`${route}: ${realB.status} vs ${none.status}`);
  }
}

// Routes whose probe with a real thing of A does NOT answer 200 for both the member and the session, and why. This list only shrinks: a route that now
// answers 200 must be taken out (the second test below), and a new route with a parameter has to answer 200 or be argued in here.
// GROUPED BY WHAT IT TAKES TO FILL, easiest first, so the next batch knows where to start (judged from each route's code, not tried, except where it says so):
//   1. state     : the probe only needs the world arranged (an event with an earlier version, a note in the trash)           — 2 routes
//   2. input     : the probe only needs one more query parameter or a body                                                   — 2 routes
//   3. seed      : (was 6: now filled: a trashed note, saved views of a note and of a tag, a drawing, a stored file, a review tag)  — 0 routes
//   4. module on : (was 5: now filled: a board, a block, two RSS routes; the fifth, skills, moved to 6)                       — 0 routes
//   5. service   : an agent session needs a runner / an external AI service behind it                                      — 1 route
//   6. never     : refused to a member too, closed to a session by design, or a thing that is the ACTOR'S OWN                — 10 routes
// ratchet:list sessionProbeNo200
const WHY = {
  state: "valid answer that is not a 200 until the world is arranged",
  input: "the route needs another query parameter or body the probe does not send (400): the answer for B's id is still checked against a made-up id",
  service: "the probe world has no such object (needs an agent runner / an external AI service): the answer for a thing of B is still checked against a made-up id",
  owner: "refused to a member too (owner-only): the refusal is the answer; the second test shows it is the same for a made-up id",
  person: "refused to a session by design (person only / MCP closed to it); the refusal is the answer",
} as const;
const NO_VALID_PROBE: Readonly<Record<string, string>> = {
  // 1. state
  "GET /api/events/:event_id/preview": `${WHY.state}: a restore preview of a real event answers 409 'nothing to restore' for an edit that has no earlier version`,
  "GET /api/nodes/:id/purge-preview": `${WHY.state}: answers 409 for a note that is not in the trash`,
  // 2. input
  "GET /api/history/at/:id": WHY.input,
  "GET /api/tags/:sourceId/merge-preview": WHY.input,
  // 5. service
  "GET /api/agent-sessions/:id": WHY.service,
  // 6. never
  "GET /api/skills/:id/skill.md": `${WHY.person}: a skill note is its CREATOR'S own (services/harness/noteSkills.ts loadSkills asks that the actor made the note): a session made none, so it gets 404 by design, a member who made one gets 200. Whether a session should read its person's skills is a decision (the PR's 需要決定), not part of "reads yours"`,
  "GET /api/actors/:id/stats": WHY.owner,
  "GET /api/actors/:id/tokens": WHY.owner,
  "GET /api/ai/credentials/:id/models": WHY.owner,
  "GET /api/git/diff/:hash": WHY.owner,
  "GET /api/spaces/:id/candidates": WHY.owner,
  "GET /api/spaces/:id/delete-preview": WHY.owner,
  "GET /api/backup/restore/:id/preview": `${WHY.person}: a backup-restore upload id`,
  "GET /api/backup/restore/jobs/:job": `${WHY.person}: a backup-restore job id`,
  "GET /api/mcp/sessions/:id": `${WHY.person}: an AI session id on the tool surface`,
};

const wordsLeaked = (viewer: Viewer, kind: keyof typeof NAME) => [...new Set(leaks[viewer].filter((h) => h.word === NAME[kind]).map((h) => h.route))];

describe.skipIf(!isTestDatabase())("what a participant limited to space A is told about space B (a plain member, and a temporary session)", () => {
  beforeAll(async () => {
    ownWorkspace = await newWorkspace("leak-probe");
    const owner = await newPerson(ownWorkspace, "Owner"), member = await newPerson(ownWorkspace, "Member");
    memberExt = member.ext;
    await setWorkspaceOwner(ownWorkspace, owner.id);
    ids.person = (await newPerson(ownWorkspace, NAME.person)).id;
    ids.agent = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,'agent') RETURNING id::text`, [ownWorkspace, NAME.agent])).rows[0]!.id;

    spaceA = await makeSpace(ownWorkspace, "space A", [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }]);
    spaceB = await makeSpace(ownWorkspace, NAME.space, [{ id: owner.id, permission: "edit" }, { id: ids.person!, permission: "edit" }, { id: ids.agent!, permission: "edit" }]);

    // Space B holds one of every kind of thing; space A holds a note and tags of its own.
    ids.note = await newNote(ownWorkspace, NAME.note, spaceB, NAME.noteBody);
    ids.tag = (await seedClassTag(ownWorkspace, { name: NAME.tag, fields: [{ key: NAME.field, label: NAME.field, type: "text" }] })).tagId;
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [ids.note, ids.tag]);
    await seedQ(`INSERT INTO node_attributes(workspace_id, node_id, key, value, value_type) VALUES($1,$2,$3,'v','text')`, [ownWorkspace, ids.note, NAME.property]);
    const noteA = await newNote(ownWorkspace, VISIBLE.noteA, spaceA, "plain");
    idsA.note = noteA; idsA.space = spaceA; idsA.member = member.id;
    await event(ownWorkspace, "NODE_UPDATED", "node", noteA, { title: VISIBLE.noteA, body_hash: "h" }, "user", owner.id);
    idsA.event = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2`, [ownWorkspace, noteA])).rows[0]!.id;
    const tagA = (await seedClassTag(ownWorkspace, { name: VISIBLE.tagA })).tagId;
    idsA.tag = tagA;
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [noteA, tagA]);
    const tagShared = (await seedClassTag(ownWorkspace, { name: VISIBLE.tagShared })).tagId;
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$3),($2,$3)`, [noteA, ids.note, tagShared]);
    await seedClassTag(ownWorkspace, { name: VISIBLE.tagUnused });
    const parent = (await seedClassTag(ownWorkspace, { name: VISIBLE.tagParent })).tagId;
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [ids.note, parent]);
    const child = (await seedClassTag(ownWorkspace, { name: `zzchild${tag}` })).tagId;
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [child, parent]);
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [noteA, child]);
    // What the owner's own writes left in the event log: a tag definition changed, a space made, a note edited.
    await event(ownWorkspace, "TAG_UPDATED", "tag", ids.tag!, { name: NAME.tag, old_name: NAME.tag }, "user", owner.id);
    await event(ownWorkspace, "SPACE_CREATED", "space", spaceB, { name: NAME.space }, "user", owner.id);
    await event(ownWorkspace, "NODE_UPDATED", "node", ids.note!, { title: NAME.note, body_hash: "h" }, "user", owner.id);
    // The owner's own: a note in the personal space, and a preference.
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
    ids.personalNote = await newNote(ownWorkspace, NAME.personalNote, personal, "mine");
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'probe', $2::jsonb)`, [owner.id, JSON.stringify({ v: NAME.personalPref })]);

    // ── The probe world for the routes that need one more thing than a note, a tag or a space of each (a trashed note, a saved view, a board, a drawing, a file, an article…):
    //    a real one in A (what a valid probe aims at) and one in B (what the session must not be able to tell from a thing that does not exist), each named so a leak can be seen.
    ownerExt = owner.ext;
    for (const id of ["review", "rss", "skills", "canvas"]) await turnModuleOn(ownWorkspace, id);
    const created = async (path: string, body: unknown) => (JSON.parse((await asOwner(path, { method: "POST", body })).text) as { id: string }).id;
    const aOrB = <T,>(t: "A" | "B", a: T, b: T): T => (t === "A" ? a : b);
    // a note in the trash
    const trash = async (title: string, space: string) => { const id = await newNote(ownWorkspace, title, space, "in the bin"); await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id]); return id; };
    const binA = await trash(`zzbinA${tag}`, spaceA), binB = await trash(NAME.deletedNote, spaceB);
    PROBES["/api/history/deleted/:id"] = one((id) => `/api/history/deleted/${id}`, (t) => aOrB(t, binA, binB));
    // a saved view on a note, and on a tag
    const noteViewA = await created(`/api/nodes/${noteA}/views`, { name: "view A" }), noteViewB = await created(`/api/nodes/${ids.note}/views`, { name: NAME.view });
    const tagViewA = await created(`/api/tags/${idsA.tag}/views`, { name: "tag view A" }), tagViewB = await created(`/api/tags/${ids.tag}/views`, { name: NAME.view });
    const two = (path: (a: string, b: string) => string, parts: (t: "A" | "B") => [string, string]) => (thing: "A" | "B" | "none"): Aimed => {
      const [x, y] = thing === "none" ? [randomUUID(), randomUUID()] : parts(thing);
      return { path: path(x, y), ids: [x, y] };
    };
    PROBES["/api/nodes/:id/views/:viewId/exec"] = two((n, v) => `/api/nodes/${n}/views/${v}/exec`, (t) => aOrB(t, [noteA, noteViewA], [ids.note!, noteViewB]));
    PROBES["/api/tags/:tagId/views/:viewId/exec"] = two((n, v) => `/api/tags/${n}/views/${v}/exec`, (t) => aOrB(t, [idsA.tag!, tagViewA], [ids.tag!, tagViewB]));
    // a whiteboard
    const boardA = await created("/api/canvases", { title: "board A", space_id: spaceA }), boardB = await created("/api/canvases", { title: NAME.board, space_id: spaceB });
    PROBES["/api/canvases/:id"] = one((id) => `/api/canvases/${id}`, (t) => aOrB(t, boardA, boardB));
    // a tag that carries the review module, on a note of each space
    const reviewTag = async (name: string, note: string) => {
      const id = (await seedClassTag(ownWorkspace, { name })).tagId;
      await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [id]);
      await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [note, id]);
      return id;
    };
    const reviewA = await reviewTag(`zzreviewA${tag}`, noteA), reviewB = await reviewTag(`${NAME.tag}review`, ids.note!);
    PROBES["/api/review/settings/:tagId"] = one((id) => `/api/review/settings/${id}`, (t) => aOrB(t, reviewA, reviewB));
    // a block of a note of each space
    const block = async (note: string, ref: string) => {
      const markdown = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [note])).rows[0]!.markdown;
      const span = { start: 0, end: markdown.split("\n")[0]!.length }; // the first line is the block
      await seedQ(`INSERT INTO block_anchors(workspace_id,anchor_id,note_id,from_utf16,to_utf16,at_body_hash,quote) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [ownWorkspace, ref, note, span.start, span.end, createHash("sha256").update(markdown).digest("hex"), markdown.slice(span.start, span.end)]);
      return (await seedQ<{ id: string }>(`INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,$3,$3,'listItem',$3) RETURNING id::text`, [ownWorkspace, note, ref])).rows[0]!.id;
    };
    const blockHostA = await newNote(ownWorkspace, "zzblocksA", spaceA, "- a question in A\n- another"), blockHostB = await newNote(ownWorkspace, `${NAME.note}blocks`, spaceB, `- ${NAME.noteBody}\n- another`);
    const blockA = await block(blockHostA, `bk${tag}a`), blockB = await block(blockHostB, `bk${tag}b`);
    PROBES["/api/review/blocks/:blockId/state"] = one((id) => `/api/review/blocks/${id}/state`, (t) => aOrB(t, blockA, blockB));
    // an RSS article of a feed in each space
    const feed = async (space: string, label: string, title: string) => {
      const source = (await seedQ<{ id: string }>(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, $3, $4) RETURNING id::text`, [ownWorkspace, space, `feed ${label}`, `https://feed.test/${label}.xml`])).rows[0]!.id;
      const item = (await seedQ<{ id: string }>(`INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, url) VALUES ($1, $2, $3, $4, $5) RETURNING id::text`, [ownWorkspace, source, `guid-${label}`, title, `https://feed.test/${label}/1`])).rows[0]!.id;
      return { item, url: `https://feed.test/${label}/1` };
    };
    const feedA = await feed(spaceA, `a${tag}`, "article A"), feedB = await feed(spaceB, `b${tag}`, NAME.article);
    PROBES["/api/rss/items/:id"] = one((id) => `/api/rss/items/${id}`, (t) => aOrB(t, feedA.item, feedB.item));
    PROBES["/api/rss/items/:id/link"] = (thing) => {
      const id = thing === "none" ? randomUUID() : aOrB(thing, feedA.item, feedB.item), url = thing === "B" ? feedB.url : feedA.url;
      return { path: `/api/rss/items/${id}/link?url=${encodeURIComponent(url)}`, ids: [id] };
    };
    // a drawing of each note, saved twice (the route reads the two drawings behind one change)
    const stroke = (id: string): InkStroke => ({ id, points: [[0, 0], [10, 10], [20, 5], [30, 30]], color: "#112233", size: 2, toolId: "pen" });
    const drawing = (strokeIds: string[]): string => encodeInk({ version: 1, strokes: strokeIds.map(stroke), erased: {}, page: { width: 1000 } } satisfies InkDocument);
    const drawn = async (note: string, saves: string[][]) => {
      for (const strokeIds of saves) await setNodeAttribute({ workspaceId: ownWorkspace, actor: owner.ctx, nodeId: note, attribute: { key: "ink_data", value: drawing(strokeIds) } });
      return (await q<{ id: string }>(`SELECT id::text AS id FROM domain_events WHERE target_id = $1 AND payload->>'key' = 'ink_data' ORDER BY domain_events.id`, [note])).rows.map((r) => r.id);
    };
    const inkA = await drawn(noteA, [["a1"], ["a1", "a2"]]), inkB = await drawn(ids.note!, [[NAME.drawing], [NAME.drawing, `${NAME.drawing}2`]]);
    PROBES["/api/nodes/:id/ink-change"] = (thing) => {
      const [note, [before, after]] = thing === "none" ? [randomUUID(), ["1000000000", "1000000001"]] as const : thing === "A" ? [noteA, inkA] as const : [ids.note!, inkB] as const;
      return { path: `/api/nodes/${note}/ink-change?before=${before}&after=${after}`, ids: [note, before!, after!] };
    };
    // a stored file embedded by a note of each space
    const file = async (colour: number, space: string, text: string) => {
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: colour, g: colour, b: colour } } }).png().toBuffer();
      const stored = await storeMedia(png, ".png", { actor: owner.ctx, workspaceId: ownWorkspace, origin: "upload" });
      if (!stored.ok) throw new Error(`media: ${stored.reason}`);
      await created("/api/nodes", { title: `holds ${stored.filename.slice(0, 6)}`, space_id: space, markdown: `${text} ![](/api/media/${stored.filename})` });
      return stored.filename;
    };
    const fileA = await file(31, spaceA, "a picture in A"), fileB = await file(97, spaceB, NAME.media);
    PROBES["/api/media/:filename"] = (thing) => { const name = thing === "none" ? `${randomUUID()}.png` : aOrB(thing, fileA, fileB); return { path: `/api/media/${name}`, ids: [name] }; };

    // The owner opens a session on A only.
    sessionCredential = (await openAs(owner, ownWorkspace, { spaces: [{ spaceId: spaceA, permission: "edit" }] })).credential;
    // The sweeps run once, here, so the order the tests below run in (the suite shuffles them) cannot matter.
    await sweep("member");
    await sweep("session");
    await probeWithIds();
    // Optional machine-readable dump, for the inventory table of the proposal document.
    if (process.env.SESSION_INVENTORY_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.SESSION_INVENTORY_OUT, JSON.stringify({ probed, leaks }, null, 1));
    }
    const kindsOf = (route: string) => Object.entries(NAME).filter(([, word]) => leaks.member.some((h) => h.route === route && h.word === word)).map(([kind]) => kind).join(", ");
    process.stdout.write(`\n[leak-inventory] ${probed.member.length} requests per viewer; routes that returned a name of space B to a MEMBER:\n${
      [...new Set(leaks.member.map((h) => h.route))].sort().map((route) => `${route}  ←  ${kindsOf(route)}`).join("\n")}\n`);
  }, 180_000);

  it("the sweep reached every mounted GET route for each of them", () => {
    expect(probed.member.length).toBeGreaterThan(200);
    expect(probed.session.length).toBe(probed.member.length);
  });

  describe("probes with real ids (a route that answers 400 or 404 read nothing)", () => {
    it("aimed at a real thing of B, the session gets exactly the answer it gets for a thing that does not exist", () => {
      expect(distinguishable).toEqual([]);
    });
    it("aimed at a real thing of A, every route with a parameter answers 200 to the member and the session, or is listed with the reason", () => {
      const no200 = paramRoutes.filter((r) => r.member !== 200 || r.session !== 200).map((r) => r.route).sort();
      if (process.env.SESSION_PROBE_DEBUG) for (const r of paramRoutes.filter((p) => p.route.replace("GET ", "") in PROBES)) process.stdout.write(`\n[newly probed] ${r.route} member=${r.member} session=${r.session} body[0..160]=${r.sessionBody.slice(0, 160).replace(/\n/g, " ")}`);
      if (process.env.SESSION_PROBE_DEBUG) process.stdout.write(`\n[no200]\n${paramRoutes.filter((r) => r.member !== 200 || r.session !== 200).map((r) => `${r.route} member=${r.member} session=${r.session}`).join("\n")}\n`);
      expect(no200.filter((route) => !(route in NO_VALID_PROBE))).toEqual([]);
      expect(Object.keys(NO_VALID_PROBE).filter((route) => !no200.includes(route)), "now answers 200: take it out of NO_VALID_PROBE").toEqual([]);
    });
    it("the session's answer for a real thing of A names nothing of B", () => {
      for (const r of paramRoutes) for (const word of Object.values(NAME)) expect([r.route, r.sessionBody.includes(word)]).toEqual([r.route, false]);
    });
  });

  describe("controls: the probe is not blind", () => {
    it("both are told the notes and tags of their own space, a tag used in both spaces, a tag nobody uses, and the parent of a tag they use", () => {
      for (const viewer of ["member", "session"] as const) {
        for (const word of Object.values(VISIBLE)) expect([viewer, word, seenBy[viewer].includes(word)]).toEqual([viewer, word, true]);
      }
    });
    it("neither reads a note of B (title, body) or the owner's personal note: the read gate holds for both", () => {
      for (const viewer of ["member", "session"] as const) {
        expect(leaks[viewer].filter((h) => ([NAME.note, NAME.noteBody, NAME.personalNote] as string[]).includes(h.word))).toEqual([]);
      }
    });
    it("the member IS told the names of the tags used only in B (tag definitions are shared vocabulary for a member: unchanged)", () => {
      expect(wordsLeaked("member", "tag")).toEqual(expect.arrayContaining(["GET /api/bootstrap", "GET /api/tags", "GET /api/tags/tree", "GET /api/sync/membership", "GET /api/events", "POST /api/sync"]));
      expect(wordsLeaked("member", "field").length).toBeGreaterThan(3);
    });
  });

  describe("a temporary session on A", () => {
    it.each(Object.keys(NAME) as Array<keyof typeof NAME>)("is told nothing that is only in B or only the owner's: %s", (kind) => {
      expect(wordsLeaked("session", kind)).toEqual([]);
    });
  });

  describe("a plain member, for the rest", () => {
    it.each(["property", "space", "person", "agent", "personalPref"] as const)("is not told %s of space B either (these never leaked)", (kind) => {
      expect(wordsLeaked("member", kind)).toEqual([]);
    });
  });
});
