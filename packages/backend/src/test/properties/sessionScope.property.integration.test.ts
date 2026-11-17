// Property: a temporary session on a set S of spaces reads and writes inside S as its person would, and nothing at all outside S.
//
// One fresh workspace per run (random: how many spaces, which of them S is, the permission the session was given in each, how many notes each holds, which
// tags are used where, who is a member of what). The owner opens a session on S. Then, over the real assembled app:
//   READ   every mounted GET route (and the read POSTs) is called as the session, aimed at things outside S as well as inside; no answer carries anything
//          that belongs only to spaces outside S: a note's id, title or body, a tag used only outside S, the name of a space outside S, a person only
//          in one. The same inside S is told to it as to the person (the note a GET /api/nodes/:id returns is the person's note, byte for byte).
//   WRITE  every write outside S is refused and changes nothing; inside S a write succeeds where the session was given edit and is refused where view.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/sessionScope.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { pool, q } from "../../db.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { seedQ } from "../helpers/seedQ.js";
import { seedClassTag } from "../helpers/seedClassTag.js";
import { mountedRoutes } from "../helpers/appRoutes.js";
import { newNote, newPerson, newWorkspace, openAs } from "../helpers/sessionWorld.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import { checkAsync } from "../helpers/propsConfig.js";

let ownWorkspace = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@property.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../../app.js");

/** A random world: spaces 0..n-1; `inSession[i]` says whether the session was opened on space i (and with which permission); each space's notes, and for each
 *  note which tags (indices into the tag list) it carries; `tagCount` tags. */
type Spec = {
  spaces: Array<{ inSession: false | "view" | "edit"; notes: Array<{ tags: number[] }>; person: boolean }>;
  tagCount: number;
};
const specArb: fc.Arbitrary<Spec> = fc.record({
  tagCount: fc.integer({ min: 1, max: 4 }),
  spaces: fc.array(fc.record({
    inSession: fc.constantFrom<false | "view" | "edit">(false, "view", "edit"),
    notes: fc.array(fc.record({ tags: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 2 }) }), { minLength: 1, maxLength: 3 }),
    person: fc.boolean(),
  }), { minLength: 2, maxLength: 4 }),
}).filter((spec) => spec.spaces.some((s) => s.inSession !== false) && spec.spaces.some((s) => s.inSession === false));

type Init = { method?: string; body?: unknown };
let credential = "";
let ownerExt = "";
async function request(who: "session" | "owner", path: string, init: Init = {}) {
  signedInAs = who === "owner" ? ownerExt : null;
  try {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { ...(who === "session" ? { authorization: `Bearer ${credential}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  } finally { signedInAs = null; }
}

type Built = {
  noteIds: Array<{ id: string; title: string; body: string; space: number; edit: boolean; inside: boolean }>;
  /** Everything that must never reach the session: words that belong only to spaces outside S. */
  secrets: string[];
  insideTitles: string[];
};

async function build(spec: Spec, run: string): Promise<Built> {
  ownWorkspace = await newWorkspace("scopeprop");
  const owner = await newPerson(ownWorkspace, "Owner");
  ownerExt = owner.ext;
  await setWorkspaceOwner(ownWorkspace, owner.id);
  const tagIds: string[] = [];
  const tagNames: string[] = [];
  for (let t = 0; t < spec.tagCount; t++) {
    const name = `zztag${run}x${t}`;
    tagNames.push(name);
    tagIds.push((await seedClassTag(ownWorkspace, { name })).tagId);
  }
  const spaceIds: string[] = [];
  const spaceNames: string[] = [];
  const personNames: string[] = [];
  for (const [i, s] of spec.spaces.entries()) {
    const members = [{ id: owner.id, permission: "edit" as const }];
    if (s.person) {
      const name = `zzperson${run}x${i}`;
      personNames.push(name);
      members.push({ id: (await newPerson(ownWorkspace, name)).id, permission: "edit" });
    }
    const name = `zzspace${run}x${i}`;
    spaceNames.push(name);
    spaceIds.push(await makeSpace(ownWorkspace, name, members));
  }
  const built: Built = { noteIds: [], secrets: [], insideTitles: [] };
  const tagUse = tagNames.map(() => new Set<number>()); // tag → spaces it is used in
  for (const [i, s] of spec.spaces.entries()) {
    for (const [n, note] of s.notes.entries()) {
      const title = `zznote${run}x${i}x${n}`, body = `zzbody${run}x${i}x${n}`;
      const id = await newNote(ownWorkspace, title, spaceIds[i]!, body);
      for (const t of note.tags) {
        const tag = t % spec.tagCount;
        await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id, tagIds[tag]]);
        tagUse[tag]!.add(i);
      }
      built.noteIds.push({ id, title, body, space: i, edit: s.inSession === "edit", inside: s.inSession !== false });
    }
  }
  const outside = (i: number) => spec.spaces[i]!.inSession === false;
  for (const [i] of spec.spaces.entries()) {
    if (outside(i)) built.secrets.push(spaceNames[i]!, ...(spec.spaces[i]!.person ? [`zzperson${run}x${i}`] : []));
    else built.insideTitles.push(spaceNames[i]!);
  }
  for (const n of built.noteIds) if (!n.inside) built.secrets.push(n.id, n.title, n.body);
  // A tag is a secret when it is in use and every space that uses it is outside S.
  for (const [t, uses] of tagUse.entries()) if (uses.size > 0 && [...uses].every(outside)) built.secrets.push(tagNames[t]!);
  void personNames;
  const chosen = spec.spaces.flatMap((s, i) => s.inSession === false ? [] : [{ spaceId: spaceIds[i]!, permission: s.inSession }]);
  credential = (await openAs(owner, ownWorkspace, { spaces: chosen, maxRequests: 100_000 })).credential;
  return built;
}

describe.skipIf(!isTestDatabase())("a session on a set of spaces S", () => {
  afterAll(async () => { await pool.end(); });

  it("tells nothing that belongs only outside S, refuses every write outside S, and inside S is the person's own view", async () => {
    let run = 0;
    await checkAsync(fc.asyncProperty(specArb, async (spec) => {
      const tag = `${(run++).toString(36)}${randomUUID().slice(0, 4)}`;
      const built = await build(spec, tag);
      const outsideNote = built.noteIds.find((n) => !n.inside)!;
      const outsideSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND name = $2`, [ownWorkspace, `zzspace${tag}x${spec.spaces.findIndex((s) => s.inSession === false)}`])).rows[0]!.id;
      const outsideTag = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title LIKE $2 ORDER BY title LIMIT 1`, [ownWorkspace, `zztag${tag}x%`])).rows[0]!.id;

      // READ: every GET route, aimed at an outside note, an outside space, a tag; and the same with a search word; plus the read POSTs.
      const answers: Array<{ route: string; status: number; text: string }> = [];
      for (const r of mountedRoutes(app, (m) => m === "GET")) {
        if (/\/stream$/.test(r.path)) continue;
        const aimed = r.path.startsWith("/api/spaces") ? outsideSpace : r.path.startsWith("/api/tags") ? outsideTag : outsideNote.id;
        for (const query of ["", `?q=${outsideNote.title}&query=${outsideNote.title}&since=0&limit=500`]) {
          const res = await request("session", r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, aimed) + query);
          answers.push({ route: `${r.path}${query}`, ...res });
        }
      }
      for (const [path, body] of [["/api/sync", { since: 0, known: [] }], ["/api/query", { limit: 500 }], ["/api/query", { q: outsideNote.title, limit: 500 }]] as const) {
        answers.push({ route: `POST ${path}`, ...(await request("session", path, { method: "POST", body })) });
      }
      const told = answers.flatMap((a) => built.secrets.filter((secret) => a.text.includes(secret)).map((secret) => `${a.route} told ${secret}`));
      expect(told).toEqual([]);

      for (const n of built.noteIds) {
        const mine = await request("session", `/api/nodes/${n.id}`);
        if (!n.inside) { expect([n.id, mine.status]).toEqual([n.id, 404]); continue; }
        const theirs = await request("owner", `/api/nodes/${n.id}`);
        expect([n.id, mine.status, mine.text]).toEqual([n.id, 200, theirs.text]); // inside S: byte for byte the person's own answer
      }
      // The bootstrap names exactly the notes of S.
      const boot = JSON.parse((await request("session", "/api/bootstrap")).text) as { nodes?: Array<{ id: string }> };
      const bootIds = new Set((boot.nodes ?? []).map((n) => n.id).filter((id) => built.noteIds.some((n) => n.id === id)));
      expect([...bootIds].sort()).toEqual(built.noteIds.filter((n) => n.inside).map((n) => n.id).sort());

      // WRITE: outside S nothing changes; inside S only where the session may edit.
      const snapshot = async () => ({
        notes: (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' ORDER BY id`, [ownWorkspace])).rows,
        events: (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1 AND event_type IN ('NODE_UPDATED', 'NODE_CREATED')`, [ownWorkspace])).rows[0]!.n,
      });
      const before = await snapshot();
      for (const n of built.noteIds.filter((x) => !x.inside)) {
        const res = await request("session", `/api/nodes/${n.id}`, { method: "PATCH", body: { title: "changed", base_markdown: n.body } });
        expect([n.id, [403, 404].includes(res.status)]).toEqual([n.id, true]);
        const created = await request("session", "/api/nodes", { method: "POST", body: { title: "into outside", markdown: "", source_type: "manual", parent_id: n.id } });
        expect([n.id, [403, 404].includes(created.status)]).toEqual([n.id, true]);
      }
      const outsideCreate = await request("session", "/api/nodes", { method: "POST", body: { title: "into outside space", markdown: "", source_type: "manual", space_id: outsideSpace } });
      expect([403, 404]).toContain(outsideCreate.status);
      expect(await snapshot()).toEqual(before);
      for (const n of built.noteIds.filter((x) => x.inside)) {
        const res = await request("session", `/api/nodes/${n.id}`, { method: "PATCH", body: { title: `${n.title}e`, base_markdown: n.body } });
        expect([n.id, res.status]).toEqual([n.id, n.edit ? 200 : 403]);
      }
    }), 15);
  }, 600_000);
});
