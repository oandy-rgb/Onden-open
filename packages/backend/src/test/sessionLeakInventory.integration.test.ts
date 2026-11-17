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
} as const;
/** Names the participant MAY be told (controls: a probe that hid everything would pass for the wrong reason). */
const VISIBLE = {
  noteA: `zznoteA${tag}`,        // a note of space A
  tagA: `zztagA${tag}`,          // a tag used in A
  tagShared: `zztagBoth${tag}`,  // a tag used in A and in B: its name says nothing the participant could not already know
  tagUnused: `zztagFree${tag}`,  // a tag nobody uses names no space
  tagParent: `zztagParent${tag}`, // a tag used only in B whose child tag is used in A: the child's path names it
} as const;

let memberExt = "";
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
    const member = await asViewer("member", filled(r.path, "A"));
    const session = await asViewer("session", filled(r.path, "A"));
    paramRoutes.push({ route, member: member.status, session: session.status, sessionBody: session.text });
    // B's real thing against a thing that does not exist: the session must not be able to tell them apart (status and text, the id itself masked)
    const mask = (text: string, id: string) => text.split(id).join("<id>");
    const bId = aimedAt(r.path, "B"), noneId = aimedAt(r.path, "none");
    const realB = await asViewer("session", r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, bId));
    const none = await asViewer("session", r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, noneId));
    if (realB.status !== none.status || mask(realB.text, bId) !== mask(none.text, noneId)) distinguishable.push(`${route}: ${realB.status} vs ${none.status}`);
  }
}

// Routes whose probe with a real thing of A does NOT answer 200 for both the member and the session, and why. This list only shrinks: a route that now
// answers 200 must be taken out (the second test below), and a new route with a parameter has to answer 200 or be argued in here.
// GROUPED BY WHAT IT TAKES TO FILL, easiest first, so the next batch knows where to start (judged from each route's code, not tried):
//   1. state     : the probe only needs the world arranged (an event with an earlier version, a note in the trash)           — 2 routes
//   2. input     : the probe only needs one more query parameter or a body                                                   — 2 routes
//   3. seed      : the probe world needs one more object seeded (a deleted note, an ink change, a view, a media file)         — 6 routes
//   4. module on : the object belongs to a module the probe world has not turned on (canvases, review, rss, skills)        — 5 routes
//   5. service   : an agent session needs a runner / an external AI service behind it                                      — 1 route
//   6. never     : refused to a member too, or closed to a session by design: the refusal IS the answer, nothing to fill     — 9 routes
// ratchet:list sessionProbeNo200
const WHY = {
  state: "valid answer that is not a 200 until the world is arranged",
  input: "the route needs another query parameter or body the probe does not send (400): the answer for B's id is still checked against a made-up id",
  seed: "the probe world has no such object (needs one more thing seeded): the answer for a thing of B is still checked against a made-up id",
  module: "the probe world has no such object (it belongs to a module the probe world has not turned on): the answer for a thing of B is still checked against a made-up id",
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
  // 3. seed
  "GET /api/history/deleted/:id": WHY.seed,
  "GET /api/media/:filename": WHY.seed,
  "GET /api/nodes/:id/ink-change": WHY.seed,
  "GET /api/nodes/:id/views/:viewId/exec": WHY.seed,
  "GET /api/tags/:tagId/views/:viewId/exec": WHY.seed,
  "GET /api/review/settings/:tagId": WHY.seed,
  // 4. module on
  "GET /api/canvases/:id": WHY.module,
  "GET /api/review/blocks/:blockId/state": WHY.module,
  "GET /api/rss/items/:id/link": WHY.module,
  "GET /api/rss/items/:id": WHY.module,
  "GET /api/skills/:id/skill.md": WHY.module,
  // 5. service
  "GET /api/agent-sessions/:id": WHY.service,
  // 6. never
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
