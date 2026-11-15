// Moving between installs, back and forth: the way a person goes from the
// browser app to the desktop app to a server and back (Settings › 你的資料 ›
// 從備份還原, mode "workspace").
//
// Three hosts, each its own database and its own media folder, loaded as
// separate copies of the backend in this one process:
//   server   the engine this run uses (real Postgres with DATABASE_URL, else PGlite)
//   desktop  PGlite
//   browser  PGlite
// The desktop and browser apps both run PGlite, so on a PGlite run the trip
// between engines is not made; the named skip below says so.
//
// fast-check generates a workspace (helpers/roundTripArb.ts) and a route: a
// list of hops, each a few edits (new note, more text, a task line, a link,
// rename, trash and back, move under another note, tag, attribute, a shared
// space and a note in it) followed by a move into a NEW workspace of some host. After every hop the workspace that
// was left and the one arrived at are read back and compared whole
// (snapshotWorkspace, noteViewsOf, the shared spaces). The one before the hop is the oracle; no
// model is kept. No edit and no move may answer 5xx.
//
// Replay a failing route with ROUNDTRIP_SEED=<seed>; ROUNDTRIP_RUNS=<n> runs more.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActorCtx } from "../../types.js";
import type { RestoreJob } from "@onden/contract";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { needsPostgresServer } from "../helpers/pgliteSkips.js";
import { roundTripRuns, word, worldSpec, STANDARD_ATTRIBUTE_KEYS, type WorldSpec } from "../helpers/roundTripArb.js";
import { APP_PARTS, appDifferences, type AppPart } from "../helpers/roundTripRich.js";
import { minimalWorld } from "../helpers/roundTripRichSpec.js";

const enabled = isTestDatabase();
type Driver = "postgres" | "pglite";
const ambient: Driver = process.env.ONDEN_DB_DRIVER === "pglite" ? "pglite" : "postgres";

// ── Hosts ────────────────────────────────────────────────────────────────────

type Place = { ws: string; actor: ActorCtx; personal: string };

/** One install: a copy of the backend with its own database and media folder. */
async function openHost(name: string, driver: Driver, scratch: string) {
  vi.resetModules();
  vi.stubEnv("ONDEN_DB_DRIVER", driver === "pglite" ? "pglite" : "");
  // Which workspace this host's routes act in. doMock, not a hoisted vi.mock: a hoisted factory is
  // run once, and every later copy would get the first host's database.
  const current = { ws: "" };
  vi.doMock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => current.ws }));
  // The media folder is `<cwd>/content/media`, fixed when git.ts loads: load
  // this copy from a folder of its own, so a file does not arrive at a host
  // just because another host of this process already has it.
  const home = process.cwd();
  const dir = mkdtempSync(join(scratch, `${name}-`));
  process.chdir(dir);
  try {
    const db = await import("../../db.js");
    if (driver === "pglite" && !process.env.ONDEN_PGLITE_SNAPSHOT) {
      // A Postgres run has no PGlite template (globalSetup builds one only for
      // PGlite runs): migrate once and let the next PGlite host start from it.
      await db.migrate();
      const file = join(scratch, "template.tar");
      writeFileSync(file, Buffer.from(await (await (await db.pglite!.database()).dumpDataDir("none")).arrayBuffer()));
      vi.stubEnv("ONDEN_PGLITE_SNAPSHOT", file);
    }
    const [world, views, rich, { apiOnError }, backup, nodes, spaces, tags, tagWrites, attributes, dispatchers, modules, jobs] = await Promise.all([
      import("../helpers/roundTripWorld.js"), import("../helpers/noteViews.js"), import("../helpers/roundTripRich.js"),
      import("../../httpError.js"), import("../../routes/backup.js"), import("../../routes/nodes.js"),
      import("../../services/spaces.js"), import("../../services/tagHierarchy.js"), import("../../services/tagMembershipWrites.js"),
      import("../../services/attributeWrites.js"), import("../../services/dispatcherQueue.js"), import("../helpers/registerShippedModules.js"),
      import("../helpers/restoreJob.js"),
    ]);
    modules.registerShippedModules();

    const app = (actor: ActorCtx) => {
      const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
      hono.onError(apiOnError);
      hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
      hono.route("/api/backup", backup.default);
      hono.route("/api/nodes", nodes.default);
      return hono;
    };
    const at = async <T>(place: Place, fn: () => T | Promise<T>): Promise<T> => { current.ws = place.ws; return fn(); };

    return {
      name, driver,
      async newPlace(label: string): Promise<Place> {
        const made = await world.freshWorkspace(label);
        const personal = (await db.q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [made.actor.id])).rows[0]!.id;
        return { ...made, personal };
      },
      build: (spec: WorldSpec, place: Place) => at(place, () => world.buildWorld(spec, place)),
      settle: () => dispatchers.awaitAllDispatchers(),
      async read(place: Place) {
        await dispatchers.awaitAllDispatchers();
        // The stored text is compared by snapshotWorkspace, which reads a typed `^id` mark and the anchor a
        // restore makes of it as the same thing; here it would only repeat that with the marks left in.
        const views = [...(await viewsOf(place)).values()].map(({ markdown: _text, ...rest }) => rest).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const spaces = (await db.q<{ name: string }>(`SELECT name FROM spaces WHERE workspace_id = $1 AND kind = 'shared' AND deleted_at IS NULL`, [place.ws])).rows.map((r) => r.name).sort();
        return { world: comparable(await world.snapshotWorkspace(place.ws)), views, spaces };
      },
      /** What the app shows (views, functions, pointers, paragraph tags, graph, typed and ink attributes), and the person's own state. */
      app: (place: Place) => at(place, async () => { await dispatchers.awaitAllDispatchers(); return rich.readApp(place.ws, place.actor); }),
      /** Every live note's versions as the history list shows them (the ungrouped feed): title and text, by note title. */
      history: (place: Place) => at(place, async () => {
        const out: Record<string, Array<{ title: unknown; markdown: string }>> = {};
        for (const note of await at(place, () => this_liveNotes(place))) {
          const versions = await (await app(place.actor).request(`/api/nodes/${note.id}/versions?raw=1`)).json() as Array<{ title?: unknown; markdown?: string }>;
          out[note.title] = versions.map((v) => ({ title: v.title ?? null, markdown: String(v.markdown ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>") })).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
        }
        return out;
      }),
      personal: (place: Place) => at(place, () => rich.readPersonal(place.ws, place.actor)),
      send: (place: Place, url: string, method: string, body?: unknown) => at(place, () => app(place.actor).request(url, {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      })),
      async download(place: Place, query = ""): Promise<Buffer> {
        const res = await at(place, () => app(place.actor).request(`/api/backup/full.zip${query}`));
        if (res.status !== 200) throw new Error(`${name}: backup ${res.status} ${await res.text()}`);
        return Buffer.from(await res.arrayBuffer());
      },
      /** Move `zip` into the new workspace `place`; the job as it ended. */
      async moveIn(place: Place, zip: Buffer): Promise<RestoreJob> {
        return at(place, async () => {
          const hono = app(place.actor);
          const up = await hono.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
          if (up.status !== 200) throw new Error(`${name}: upload ${up.status} ${await up.text()}`);
          const { upload_id } = await up.json() as { upload_id: string };
          const started = await hono.request(`/api/backup/restore/${upload_id}/apply`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: place.personal, mode: "workspace" }),
          });
          if (started.status !== 202 && started.status !== 200) throw new Error(`${name}: move refused ${started.status} ${await started.text()}`);
          return jobs.waitForJob(hono, ((await started.json()) as { job: RestoreJob }).job);
        });
      },
      /** Live notes a person sees in lists, by title. */
      liveNotes: async (place: Place) => (await db.q<{ id: string; title: string }>(
        `SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND NOT hidden AND deleted_at IS NULL ORDER BY title, id`, [place.ws])).rows,
      trashedNotes: async (place: Place) => (await db.q<{ id: string }>(
        `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND NOT hidden AND deleted_at IS NOT NULL ORDER BY title, id`, [place.ws])).rows,
      liveTags: async (place: Place) => (await db.q<{ id: string }>(
        `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND reserved_key IS NULL AND deleted_at IS NULL ORDER BY title, id`, [place.ws])).rows,
      sharedSpaces: async (place: Place) => (await db.q<{ id: string }>(
        `SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'shared' AND NOT is_default AND deleted_at IS NULL ORDER BY name`, [place.ws])).rows,
      newSpace: (place: Place, spaceName: string) => at(place, () => spaces.createSharedSpace(place.actor, place.ws, spaceName)),
      newTag: (place: Place, tagName: string) => at(place, () => tags.createTag({ actor: place.actor, workspaceId: place.ws, name: tagName })),
      tag: (place: Place, nodeId: string, tagId: string) => at(place, () => tagWrites.applyTagToNode({ workspaceId: place.ws, actor: place.actor, nodeId, tagId })),
      attribute: (place: Place, nodeId: string, key: string, value: string) => at(place, () => attributes.setNodeAttribute({ workspaceId: place.ws, actor: place.actor, nodeId, attribute: { key, value } })),
      close: () => db.pool.end(),
    };

    async function this_liveNotes(place: Place) {
      return (await db.q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND NOT hidden AND deleted_at IS NULL ORDER BY title, id`, [place.ws])).rows;
    }
    function viewsOf(place: Place) { return views.noteViewsOf(place.ws); }
  } finally {
    process.chdir(home);
  }
}
type Host = Awaited<ReturnType<typeof openHost>>;

/** A snapshot as two hosts can be compared by.
 *  - A restore makes the anchor of a `{task}` line again, under a new id (backupRestore.ts anchorRemap): an id
 *    nothing mentions is compared as "an anchor"; one some text refers to must stay.
 *  - snapshotWorkspace sorts in SQL, and Postgres and PGlite order titles differently (collation): sorted here. */
function comparable<T extends { notes: Array<{ title: string; body: string; blockRefs: string[] }>; tasks: Array<{ title: string; host: string | null; body: string }>; canvases: Array<{ title: string }> }>(snapshot: T): T {
  const text = [...snapshot.notes, ...snapshot.tasks].map((x) => x.body).join("\n");
  const by = <X>(key: (x: X) => string) => (a: X, b: X) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    ...snapshot,
    notes: snapshot.notes.map((n) => ({ ...n, blockRefs: n.blockRefs.map((id) => (text.includes(id) ? id : "(an anchor)")).sort() })).sort(by((n) => n.title)),
    tasks: [...snapshot.tasks].sort(by((t) => `${t.title}\u0000${t.host ?? ""}\u0000${t.body}`)),
    canvases: [...snapshot.canvases].sort(by((c) => c.title)),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** An edit between two moves. A roll picks its note (or tag, space) among what is there when it runs. */
type Edit =
  | { kind: "add"; text: string; body: string[]; under: number | null; shared: boolean }
  | { kind: "write"; note: number; line: string; as: "text" | "task" | "done" }
  | { kind: "link"; note: number; to: number }
  | { kind: "rename"; note: number; text: string }
  | { kind: "trash"; note: number }
  | { kind: "untrash"; note: number }
  | { kind: "moveUnder"; note: number; under: number | null }
  | { kind: "tag"; note: number; tag: number; text: string }
  | { kind: "attribute"; note: number; key: string; value: string }
  | { kind: "space"; text: string };
type Hop = { edits: Edit[]; to: number };
type Route = { spec: WorldSpec; from: number; hops: Hop[] };

const roll = fc.nat({ max: 999 });
const line = fc.array(word, { minLength: 1, maxLength: 6 }).map((words) => words.join(" "));
const edit: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("add" as const), text: word, body: fc.array(line, { maxLength: 3 }), under: fc.option(roll, { nil: null }), shared: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("write" as const), note: roll, line, as: fc.constantFrom("text" as const, "task" as const, "done" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("link" as const), note: roll, to: roll }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("rename" as const), note: roll, text: word }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("trash" as const), note: roll }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("untrash" as const), note: roll }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("moveUnder" as const), note: roll, under: fc.option(roll, { nil: null }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("tag" as const), note: roll, tag: roll, text: word }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("attribute" as const), note: roll, key: fc.constantFrom(...STANDARD_ATTRIBUTE_KEYS), value: line }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("space" as const), text: word }) },
);
const routeOf = (rich: boolean): fc.Arbitrary<Route> => fc.record({
  spec: worldSpec({ maxNotes: 5, trashed: true, exotic: "values", canvas: true, tagFunctions: true, media: true, linksToTrashed: true, standaloneTasks: 2, ...(rich ? { rich } : {}) }),
  from: fc.nat({ max: 2 }),
  hops: fc.array(fc.record({ edits: fc.array(edit, { maxLength: 5 }), to: fc.nat({ max: 2 }) }), { minLength: 2, maxLength: 4 }),
});
const route = routeOf(false);

/** Run one edit as the owner. A refusal (4xx: a cycle, a name in use) is an answer; a 5xx is not. */
async function apply(host: Host, place: Place, e: Edit, unique: () => string): Promise<void> {
  const notes = await host.liveNotes(place);
  const pick = <T>(list: T[], n: number): T | undefined => (list.length ? list[n % list.length] : undefined);
  const answered = async (res: Response, what: string) => {
    expect(res.status, `${host.name}: ${what} → ${res.status} ${res.status >= 500 ? await res.clone().text() : ""}`).toBeLessThan(500);
  };
  if (e.kind === "add") {
    const space = e.shared ? pick(await host.sharedSpaces(place), e.under ?? 0)?.id : undefined;
    const parent = space || e.under === null ? undefined : pick(notes, e.under)?.id;
    await answered(await host.send(place, "/api/nodes", "POST", {
      title: `${e.text} ${unique()}`, markdown: e.body.map((l) => `${l}\n`).join("\n"),
      ...(parent ? { parent_id: parent } : {}), ...(space ? { space_id: space } : {}),
    }), "new note");
    return;
  }
  if (e.kind === "space") { await host.newSpace(place, `${e.text} ${unique()}`); return; }
  if (e.kind === "untrash") {
    const gone = pick(await host.trashedNotes(place), e.note);
    if (gone) await answered(await host.send(place, `/api/nodes/${gone.id}/undelete`, "POST"), "out of the trash");
    return;
  }
  const note = pick(notes, e.note);
  if (!note) return;
  const append = async (text: string, what: string) => {
    const stored = await (await host.send(place, `/api/nodes/${note.id}`, "GET")).json() as { markdown?: string };
    await answered(await host.send(place, `/api/nodes/${note.id}`, "PATCH", { markdown: `${stored.markdown ?? ""}\n\n${text}\n` }), what);
  };
  if (e.kind === "write") {
    await append(e.as === "text" ? e.line : `- [${e.as === "done" ? "x" : " "}] ${e.line} ${unique()} {task}`, e.as === "text" ? "more text" : "a task line");
  } else if (e.kind === "link") {
    const to = pick(notes, e.to)!;
    if (to.id !== note.id) await append(`見 [[${to.title}]]`, "a link");
  } else if (e.kind === "rename") {
    await answered(await host.send(place, `/api/nodes/${note.id}`, "PATCH", { title: `${e.text} ${unique()}` }), "rename");
  } else if (e.kind === "trash") {
    await answered(await host.send(place, `/api/nodes/${note.id}`, "DELETE"), "trash");
  } else if (e.kind === "moveUnder") {
    const under = e.under === null ? null : pick(notes, e.under)?.id ?? null;
    if (under === note.id) return;
    await answered(await host.send(place, `/api/nodes/${note.id}`, "PATCH", { parent_id: under }), "move under");
  } else if (e.kind === "tag") {
    const tags = await host.liveTags(place);
    const tagId = pick(tags, e.tag)?.id ?? (await host.newTag(place, `${e.text} ${unique()}`)).id;
    await host.tag(place, note.id, tagId);
  } else {
    await host.attribute(place, note.id, e.key, e.value);
  }
}

// ── The property ─────────────────────────────────────────────────────────────

describe.skipIf(!enabled)("moving a workspace from host to host", () => {
  // Made in beforeAll, not while collecting: a skipped describe never runs its afterAll, so a directory made here would stay.
  let scratch = "";
  let hosts: Host[] = [];

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "onden-hosthop-"));
    hosts = [await openHost("server", ambient, scratch), await openHost("desktop", "pglite", scratch), await openHost("browser", "pglite", scratch)];
  }, 180_000);
  afterAll(async () => {
    for (const host of hosts) await host.close().catch(() => {});
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it.skipIf(needsPostgresServer)("one of the hosts is real Postgres, so the trip crosses engines", () => {
    expect(hosts.map((h) => h.driver)).toEqual(["postgres", "pglite", "pglite"]);
  });

  // Found by the property below. The body held a typed `^id` mark, so the restore took it for a backup from before
  // anchors and left the backup's own anchor list unused: the task line came back under a new anchor, the task the
  // backup held for it found no line, and was made a second time.
  it("a task line in a note that also has a typed ^id mark comes back as one task", async () => {
    for (const to of hosts) {
      const from = hosts[0]!;
      const left = await from.newPlace("hop-mark");
      const made = await from.send(left, "/api/nodes", "POST", { title: "Host note", markdown: "para ^abcd12\n\n- [ ] do it {task}\n" });
      expect(made.status).toBe(201);
      const before = await from.read(left);
      const arrived = await to.newPlace("hop-mark");
      expect((await to.moveIn(arrived, await from.download(left))).status).toBe("done");
      const after = await to.read(arrived);
      expect(before.world.tasks.map((t) => t.title), "tasks before").toEqual(["do it"]);
      expect(after.world.tasks, `${from.name} → ${to.name}`).toEqual(before.world.tasks);
    }
  }, 120_000);

  it("edits and moves in any order keep every note, tag, task, board and file", async () => {
    await fc.assert(fc.asyncProperty(route, async ({ spec, from, hops }) => {
      let n = 0;
      const unique = () => `h${++n}`;
      let host = hosts[from]!;
      let place = await host.newPlace("hop-start");
      await host.build(spec, place);
      const path = [host.name];
      for (const hop of hops) {
        for (const e of hop.edits) await apply(host, place, e, unique);
        const before = await host.read(place);
        const zip = await host.download(place);

        const next = hosts[hop.to]!;
        const arrived = await next.newPlace("hop");
        path.push(next.name);
        const job = await next.moveIn(arrived, zip);
        expect(job.status, `${path.join(" → ")}: ${job.error ?? ""}`).toBe("done");
        const after = await next.read(arrived);

        const where = path.join(" → ");
        expect(after.world.notes.map((x) => [x.title, x.parent, x.deleted]), `${where}: which notes, where, trash`).toEqual(before.world.notes.map((x) => [x.title, x.parent, x.deleted]));
        expect(after.world.notes, `${where}: notes`).toEqual(before.world.notes);
        expect(after.world.tasks, `${where}: tasks`).toEqual(before.world.tasks);
        expect(after.world.tags, `${where}: tags`).toEqual(before.world.tags);
        expect(after.world.canvases, `${where}: boards`).toEqual(before.world.canvases);
        expect(after.views, `${where}: spaces, slugs, system attributes, links`).toEqual(before.views);
        expect(after.spaces, `${where}: shared spaces`).toEqual(before.spaces);
        host = next;
        place = arrived;
      }
    }), roundTripRuns({ maxRuns: 6 }));
  }, 900_000);

  // ── What a person sees, and their own state, across hosts ──────────────────────────────────────────────────────────
  // A route over a world that also has saved views, tag functions, extends, pointers, paragraph tags, graph positions, typed
  // and ink attributes, review progress, personal settings and RSS subscriptions (helpers/roundTripRich.ts). The move is a
  // workspace move, the one that carries the person's own state (backupExtras.ts).
  async function hopsKeep(parts: readonly AppPart[], personal: boolean, { spec, from, hops }: Route, withHistory = false) {
    let n = 0;
    const unique = () => `r${++n}`;
    let host = hosts[from]!;
    let place = await host.newPlace("hop-rich");
    await host.build(spec, place);
    const path = [host.name];
    for (const hop of hops) {
      for (const e of hop.edits) await apply(host, place, e, unique);
      const before = { app: await host.app(place), own: await host.personal(place), versions: withHistory ? await host.history(place) : null };
      const next = hosts[hop.to]!;
      const arrived = await next.newPlace("hop");
      path.push(next.name);
      const job = await next.moveIn(arrived, await host.download(place, withHistory ? "?history=1" : ""));
      expect(job.status, `${path.join(" → ")}: ${job.error ?? ""}`).toBe("done");
      const where = path.join(" → ");
      expect(appDifferences(before.app, await next.app(arrived), parts), `${where}: what the app shows`).toEqual({});
      // The notes saved from a subscription are compared in the FINDING below, not here.
      const noSaved = (own: typeof before.own) => ({ ...own, rss: own.rss.map(({ saved: _saved, ...rest }) => rest) });
      if (personal) expect(noSaved(await next.personal(arrived)), `${where}: review progress, personal settings, subscriptions`).toEqual(noSaved(before.own));
      // Version history (format 3, #1592): a move with history keeps every note's versions (title and text of each).
      // The restore itself saves each note once more (its creation in the new workspace), so the arrived list may hold more,
      // never fewer: every version the note had is still there.
      if (withHistory) {
        const got = await next.history(arrived);
        for (const [title, versions] of Object.entries(before.versions!)) {
          const left = [...(got[title] ?? [])].map((v) => JSON.stringify(v));
          for (const v of versions) {
            const at = left.indexOf(JSON.stringify(v));
            expect(at, `${where}: version history of "${title}" lost a version: ${JSON.stringify(v).slice(0, 120)}`).toBeGreaterThanOrEqual(0);
            left.splice(at, 1);
          }
        }
      }
      host = next;
      place = arrived;
    }
  }

  it("a move that takes the version history along keeps every note's versions", async () => {
    await fc.assert(fc.asyncProperty(routeOf(true), (r) => hopsKeep(["attributes", "ink"], false, r, true)), roundTripRuns({ maxRuns: 3 }));
  }, 900_000);

  it("moves keep typed attributes, ink, and the person's review progress, personal settings and RSS subscriptions", async () => {
    await fc.assert(fc.asyncProperty(routeOf(true), (r) => hopsKeep(["attributes", "ink"], true, r)), roundTripRuns({ maxRuns: 4 }));
  }, 900_000);

  // FINDING rss-saved-notes: a note saved from a feed keeps `_rss_source` (the subscription's id, modules/rss/sources.ts). A
  // move gives the subscription a new id when its own is taken (backupExtras.ts importExtras: `taken ? randomUUID() : r.id`,
  // always so on the same server) and the note's attribute is not mapped, so the note no longer belongs to its feed: the
  // feed's list of saved notes is empty. Found by the property above on seeds 1, 2 (server → server, browser → browser).
  it.fails("FINDING rss-saved-notes: after a move, a note saved from a subscription still belongs to that subscription", async () => {
    const from = hosts[0]!;
    const left = await from.newPlace("hop-rss");
    await from.build(minimalWorld({ rss: [{ title: "Feed", url: "https://example.com/feed.xml", intervalMinutes: 60, embed: false, alwaysFulltext: false, saved: [0] }] }), left);
    const before = await from.personal(left);
    expect(before.rss.map((r) => r.saved), "the feed has its saved note before").toEqual([["Note one"]]);
    const arrived = await from.newPlace("hop-rss");
    expect((await from.moveIn(arrived, await from.download(left))).status).toBe("done");
    expect((await from.personal(arrived)).rss.map((r) => r.saved)).toEqual([["Note one"]]);
  }, 120_000);

  // Fixed: what a move into a new workspace and server brings of the views (ids inside them too), tag functions and `extends`.
  it("moves keep the views, the functions of tags and extends, with every id they name rewritten", async () => {
    const holds = routeOf(true).filter(({ spec }) => spec.rich!.tagViews.length + spec.rich!.noteViews.length + spec.rich!.functions.length + spec.rich!.extendsLinks.length > 0);
    await fc.assert(fc.asyncProperty(holds, (r) => hopsKeep(["tagViews", "noteViews", "noteTabs", "tagFunctions", "tagExtends"], false, r)), roundTripRuns({ maxRuns: 4 }));
  }, 900_000);

  // Pinned with the named losses of backupRoundTrip.property.test.ts (the same defects: views, functions, `extends`,
  // pointers, graph positions, paragraph tags); red when the last is fixed: delete `.fails`.
  it.fails("FINDING backup-app-parts: moves keep the views, functions, extends, pointers, graph and paragraph tags", async () => {
    const lossy = routeOf(true).filter(({ spec }) => spec.rich!.tagViews.length + spec.rich!.noteViews.length + spec.rich!.functions.length + spec.rich!.extendsLinks.length + spec.rich!.pointers.length + spec.rich!.graph.length > 0);
    await fc.assert(fc.asyncProperty(lossy, (r) => hopsKeep(APP_PARTS, false, r)), roundTripRuns({ maxRuns: 4 }));
  }, 900_000);
});
