// Property test of 「匿名訪客拿得到什麼」: after any run of publish / unpublish / trash /
// undelete / move-space / rename / edit-body / re-parent / space-switch operations,
// everything an anonymous visitor can get from the published site (the served
// pages, the frozen design, the note's address, the media files) comes only from
// notes that are public RIGHT NOW (publishedNodeIds), without publishing again in
// between: a takedown is a privacy guarantee that cannot wait for the next Publish.
//
// Each run makes its own workspace with 5 notes. Every note carries unique tokens
// in its title and body and an image it uploaded; bodies link to each other by
// title (`[[title]]`), so a token of a private note showing up anywhere in the
// anonymous payload is a leak. Operations go through the real routes
// (PATCH / DELETE / PUT attributes / POST publish) and services (moveToSpace).
//
// Checked after EVERY operation (not just at the end):
//   1. served pages ⊆ publishedNodeIds; the frozen edges and parents stay inside them;
//   2. no title/body token of a note outside the public set appears in the served payload;
//   3. the media gate for an anonymous reader (mediaAccess.canReadMedia(null)) opens a
//      file only when its owning note is public now;
//   4. publishedUrlFor answers only for public notes;
//   5. the publish candidate (what the preview lists and a publish stores) holds exactly
//      publishedNodeIds, so preview and publish are one algorithm;
//   6. served slugs are unique.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> (helpers/propsConfig).
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { pool, q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import publishRouter from "../../modules/website/routes.js";
import { moveToSpace } from "../../services/spaces.js";
import { canReadMedia } from "../../services/mediaAccess.js";
import { sitePathFor } from "@onden/markdown";
import { loadServedSite, publishedUrlFor } from "../../modules/website/publishing/servedSite.js";
import { publishedNodeIds } from "../../modules/website/publishing/publishedSet.js";
import { buildCandidate } from "../../modules/website/publishing/snapshot.js";
import { sha256Hex } from "../../utils.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "../helpers/spaceFixtures.js";
import { seedQ } from "../helpers/seedQ.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { postVia, publishWithPreview } from "../helpers/publishWithPreview.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
const DEFAULT_RUNS = 12;
const NOTES = 5;

let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();

const json = (method: string, body: unknown = {}) =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

type Op =
  | { kind: "mark"; note: number }
  | { kind: "unmark"; note: number }
  | { kind: "publish" }
  | { kind: "trash"; note: number }
  | { kind: "undelete"; note: number }
  | { kind: "move"; note: number; to: "pub" | "priv" }
  | { kind: "rename"; note: number }
  | { kind: "edit"; note: number; link: number }
  | { kind: "reparent"; note: number; parent: number | null }
  | { kind: "spaceSwitch"; space: "pub" | "priv"; on: boolean };

const noteIx = fc.integer({ min: 0, max: NOTES - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: noteIx.map((note): Op => ({ kind: "mark", note })) },
  { weight: 2, arbitrary: noteIx.map((note): Op => ({ kind: "unmark", note })) },
  { weight: 4, arbitrary: fc.constant<Op>({ kind: "publish" }) },
  { weight: 2, arbitrary: noteIx.map((note): Op => ({ kind: "trash", note })) },
  { weight: 2, arbitrary: noteIx.map((note): Op => ({ kind: "undelete", note })) },
  { weight: 2, arbitrary: fc.tuple(noteIx, fc.constantFrom("pub", "priv")).map(([note, to]): Op => ({ kind: "move", note, to })) },
  { weight: 1, arbitrary: noteIx.map((note): Op => ({ kind: "rename", note })) },
  { weight: 2, arbitrary: fc.tuple(noteIx, noteIx).map(([note, link]): Op => ({ kind: "edit", note, link })) },
  { weight: 2, arbitrary: fc.tuple(noteIx, fc.option(noteIx, { nil: null })).map(([note, parent]): Op => ({ kind: "reparent", note, parent })) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom("pub", "priv"), fc.boolean()).map(([space, on]): Op => ({ kind: "spaceSwitch", space, on })) },
);

type World = { spaces: { pub: string; priv: string }; ids: string[]; titles: string[]; files: string[]; tag: string; renames: number[] };

const tokenOf = (w: World, i: number, part: "t" | "b") => `tk${w.tag}n${i}${part}x`;
const bodyOf = (w: World, i: number, link: number) =>
  `body ${tokenOf(w, i, "b")} see [[${w.titles[link]}]] and ![pic](/api/media/${w.files[i]})`;

/** `tagged`: every note carries one shown tag, so the site has a tag page whose rows freeze each note's excerpt. */
async function buildWorld(tagged: boolean): Promise<World> {
  workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Anon view', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
  const admin: ActorCtx = await persistActor(workspaceId, { id: "x", name: "Owner", role: "admin", type: "human" });
  currentActor = admin;
  const tag = randomUUID().replace(/\D/g, "").slice(0, 8) || "0";
  const pub = await makeSpace(workspaceId, `pub-${tag}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  const priv = await makeSpace(workspaceId, `priv-${tag}`, [{ id: admin.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
  const tagId = tagged ? (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','class_tag','shown','shown-tag','') RETURNING id::text`, [workspaceId])).rows[0]!.id : "";
  const w: World = { spaces: { pub, priv }, ids: [], titles: [], files: [], tag, renames: Array(NOTES).fill(0) };
  for (let i = 0; i < NOTES; i++) {
    w.titles.push(`Title ${tokenOf(w, i, "t")}`);
    w.files.push(`${sha256Hex(`${tag}-${i}`).slice(0, 32)}.png`);
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'') RETURNING id::text`, [workspaceId, w.titles[i], `slug-${tag}-${i}`])).rows[0]!.id;
    w.ids.push(id);
    await putInSpace(id, i % 2 === 0 ? pub : priv);
    if (tagged) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1,$2,$3)`, [w.files[i], workspaceId, admin.id]);
  }
  // The bodies are saved through the route, which is what claims each image for its note.
  for (let i = 0; i < NOTES; i++) {
    const res = await app.request(`/api/nodes/${w.ids[i]}`, json("PATCH", { markdown: bodyOf(w, i, (i + 1) % NOTES) }));
    expect(res.status).toBe(200);
  }
  return w;
}

async function apply(w: World, op: Op): Promise<void> {
  const id = op.kind === "publish" || op.kind === "spaceSwitch" ? "" : w.ids[op.note]!;
  switch (op.kind) {
    case "mark": await app.request(`/api/nodes/${id}/attributes/_published`, json("PUT", { value: "true", value_type: "bool" })); break;
    case "unmark": await app.request(`/api/nodes/${id}/attributes/_published`, json("PUT", { value: "false", value_type: "bool" })); break;
    case "publish": await publishWithPreview(postVia(app)); break;
    case "trash": await app.request(`/api/nodes/${id}`, { method: "DELETE" }); break;
    case "undelete": await app.request(`/api/nodes/${id}/undelete`, json("POST")); break;
    case "move": {
      const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!.e;
      await moveToSpace(currentActor!, workspaceId, id, w.spaces[op.to], epoch).catch(() => {});
      break;
    }
    case "rename": {
      w.renames[op.note]!++;
      // The token stays in the title: a renamed note is still that note.
      w.titles[op.note] = `Title ${tokenOf(w, op.note, "t")} r${w.renames[op.note]}`;
      await app.request(`/api/nodes/${id}`, json("PATCH", { title: w.titles[op.note] }));
      break;
    }
    case "edit": await app.request(`/api/nodes/${id}`, json("PATCH", { markdown: bodyOf(w, op.note, op.link) })); break;
    case "reparent":
      // Setup-level write (a parent in another space is what the move route would have refused).
      // The database refuses a parent in another space (content_nodes_space_matches_parent): such a step is a no-op.
      await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [id, op.parent === null || op.parent === op.note ? null : w.ids[op.parent]]).catch(() => {});
      break;
    case "spaceSwitch":
      await seedQ(`UPDATE spaces SET capabilities = jsonb_set(capabilities, '{publish}', $2::jsonb) WHERE id = $1`, [w.spaces[op.space], JSON.stringify(op.on)]);
      break;
  }
}

/** What the runs reached, so a green run that never put anything on the site is visible (asserted below). */
const reached = { servedNonEmpty: 0, takenDown: 0, mediaOpen: 0, checks: 0 };
let everServed = new Set<string>();
const resetReached = () => { Object.assign(reached, { servedNonEmpty: 0, takenDown: 0, mediaOpen: 0, checks: 0 }); everServed = new Set(); };

async function assertAnonymousView(w: World, history: Op[]): Promise<void> {
  const why = `after ${JSON.stringify(history)}`;
  const publicNow = await publishedNodeIds(workspaceId);
  const site = await loadServedSite(workspaceId);
  const nodes = (site.payload.nodes ?? []) as Array<{ id: string; slug: string; parent_id: string | null }>;
  const servedIds = new Set(nodes.map((n) => n.id));
  reached.checks++;
  if (servedIds.size > 0) reached.servedNonEmpty++;
  for (const id of servedIds) everServed.add(id);
  for (const id of everServed) if (!publicNow.has(id)) reached.takenDown++;
  // 1
  for (const id of servedIds) expect(publicNow.has(id), `${why}: served page ${id} is not public now`).toBe(true);
  for (const n of nodes) if (n.parent_id !== null) expect(servedIds.has(n.parent_id), `${why}: parent of a served page is not served`).toBe(true);
  for (const e of (site.payload.edges ?? []) as Array<{ source_node_id: string; target_node_id: string }>) {
    expect(servedIds.has(e.source_node_id) && servedIds.has(e.target_node_id), `${why}: an edge leaves the served set`).toBe(true);
  }
  // 2
  const blob = JSON.stringify(site.payload);
  for (let i = 0; i < NOTES; i++) {
    if (publicNow.has(w.ids[i]!)) continue;
    expect(blob.includes(tokenOf(w, i, "t")), `${why}: title token of private note ${i} is in the served payload`).toBe(false);
    expect(blob.includes(tokenOf(w, i, "b")), `${why}: body token of private note ${i} is in the served payload`).toBe(false);
    expect(blob.includes(w.ids[i]!), `${why}: id of private note ${i} is in the served payload`).toBe(false);
  }
  // 3
  for (let i = 0; i < NOTES; i++) {
    const open = await canReadMedia(null, w.files[i]!, workspaceId);
    if (open) reached.mediaOpen++;
    if (open) expect(publicNow.has(w.ids[i]!) && servedIds.has(w.ids[i]!), `${why}: anonymous reader opens the image of note ${i}, which is not on the site`).toBe(true);
  }
  // 4
  for (let i = 0; i < NOTES; i++) {
    const url = await publishedUrlFor(workspaceId, w.ids[i]!);
    if (url !== null) expect(publicNow.has(w.ids[i]!), `${why}: address handed out for private note ${i}`).toBe(true);
    // The one-note lookup answers as the full served site does (it used to load all of it).
    expect(url, `${why}: the address of note ${i} differs from the served site's`).toBe(sitePathFor(w.ids[i]!, nodes));
  }
  // 5
  const candidate = await buildCandidate(workspaceId, { title: "t", actor: currentActor });
  const candidateIds = ((candidate.payload.nodes ?? []) as Array<{ id: string }>).map((n) => n.id).sort();
  expect(candidateIds, `${why}: the candidate differs from publishedNodeIds`).toEqual([...publicNow].sort());
  // 6
  expect(new Set(nodes.map((n) => n.slug)).size, `${why}: duplicate served slugs`).toBe(nodes.length);
}

const runWith = (tagged: boolean) => async (ops: Op[]): Promise<void> => {
  const w = await buildWorld(tagged);
  const done: Op[] = [];
  // Every run starts from a published site: the notes of the publishing space marked and published, each linking to
  // another published one, so a takedown has something to take down (and something that names it).
  for (const note of [0, 2, 4]) {
    await apply(w, { kind: "edit", note, link: (note + 2) % NOTES });
    await apply(w, { kind: "mark", note });
  }
  await apply(w, { kind: "publish" });
  await assertAnonymousView(w, done);
  for (const op of ops) {
    await apply(w, op);
    done.push(op);
    await assertAnonymousView(w, done);
  }
};

describe.skipIf(!isTestDb)("匿名訪客能拿到的內容 properties (published site)", () => {
  beforeAll(() => { registerShippedModules(); });
  afterAll(async () => { await pool.end(); });

  it("after every operation, anonymous-visible content comes only from notes public right now", async () => {
    const runs = process.env.PROPS_RUNS ? Infinity : DEFAULT_RUNS;
    resetReached();
    await checkAsync(fc.asyncProperty(fc.array(opArb, { minLength: 3, maxLength: 14 }), runWith(false)), runs);
    // The generator must reach the interesting states: pages served, a served page taken down since, an image open to the public.
    expect(reached.servedNonEmpty).toBeGreaterThan(reached.checks / 10);
    expect(reached.takenDown).toBeGreaterThan(0);
    expect(reached.mediaOpen).toBeGreaterThan(0);
  }, 600_000);

  // The same property over a site that has a tag page. CONFIRMED DEFECT (review 2026-11-11, finding P1): the rows a tag
  // page freezes carry each note's excerpt, built from text that links to other notes by title; the takedown removes the
  // rows of notes no longer public but leaves the title of a taken-down note inside another row's excerpt (and the
  // purge of a note erases it by id only, so it stays there too). Fix direction: see publishFrozenLeaks.integration.test.ts.
  // Turns red the day it is fixed: change `it.fails` to `it`.
  it("with a tag page on the site, after every operation, no title of a note outside the public set is served", async () => {
    const runs = process.env.PROPS_RUNS ? Infinity : DEFAULT_RUNS;
    await checkAsync(fc.asyncProperty(fc.array(opArb, { minLength: 3, maxLength: 14 }), runWith(true)), runs);
  }, 600_000);
});
