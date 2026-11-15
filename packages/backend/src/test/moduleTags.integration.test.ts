// Module tags and extends (docs/architecture/module-library.md, phase 2).
//
//   • Importing a module that gives tags an ability creates its module tag in
//     the name the client sends (the interface language), or adopts a top-level
//     tag already named like it; importing again keeps that tag; removing the
//     module keeps it too.
//   • A tag provides a module when it is the module tag, has the legacy switch,
//     or extends (at any depth) a tag that provides it. The nearest providing
//     tag's settings apply. Cycles and missing tags contribute nothing.
//   • Extends is a principal-admin decision; it refuses the tag itself, cycles
//     and missing tags, records TAG_SCHEMA_UPDATED, is a no-op when unchanged,
//     gives a label a private schema, and can be restored — never into a cycle.
//   • Review enrols the notes of extending tags, a tag scope includes the tags
//     that extend it, and a workspace that has not imported Review enrols none.
//   • The catalog carries the module, the extends list and effective modules.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { registerStandInFunction } from "./helpers/registerStandInFunction.js";
import reviewRouter from "../modules/review/routes.js";
import tagsRouter from "../routes/tags.js";
import { setModuleImported } from "../services/workspaceModules.js";
import { putTagExtends as setTagExtends } from "../services/legacyTagFunctionWrites.js";
import { addFunction, FunctionRefError as TagModuleError, functionIndex } from "../services/functionRefs.js";
import { giveFunction } from "./helpers/seedClassTag.js";
import { changeTagSchema } from "../services/tagWrites.js";
import { readTagCatalog } from "../services/tagCatalog.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
registerStandInFunction();

const NOW = "2026-10-12T08:00:00.000Z";
let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter).route("/api/tags", tagsRouter);
const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const queue = async (tagId?: string) => ((await (await req(`/api/review/queue?now=${NOW}${tagId ? `&tag_id=${tagId}` : ""}`)).json()) as
  { cards: Array<{ node_id: string }> }).cards.map((card) => card.node_id);

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("module tags and extends", () => {
  let ws = "";
  let admin: ActorCtx;
  let editor: ActorCtx;
  const label = async (title = `label-${randomUUID().slice(0, 8)}`) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id`, [ws, title, `tag-${randomUUID()}`],
  )).rows[0]!.id;
  const moduleTag = async (module: string, behaviour: Record<string, unknown> = {}) => {
    const { tagId } = await seedClassTag(ws, { name: `${module}-${randomUUID().slice(0, 8)}`, behaviour });
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', $2::text) WHERE id = $1`, [tagId, module]);
    await giveFunction(ws, tagId, module); // a module tag holds its own function (writeTagSchema does this for a real write)
    return tagId;
  };
  const note = async (tagIds: string[]) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug)
             VALUES ($1::uuid, $2, 'manual', 'content', 'Card', $1::text)`, [id, ws]);
    for (const tagId of tagIds) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    return id;
  };
  // A user tag extending a user tag is legacy (#360): PUT /extends refuses a
  // new one (D105). Data from before that is written by the extends writer
  // itself, which records it like any extends change.
  const legacyExtends = async (tagId: string, targets: string[]) => {
    const tag = (await q<{ id: string; title: string; tag_schema: Record<string, unknown> | null }>(
      `SELECT id::text, title, tag_schema FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!;
    await changeTagSchema({ actor: admin, workspaceId: ws, tag, patch: { extends: targets }, whenNew: "private", uiContext: "test.legacy" });
  };
  const schemaEvents = async (tagId: string) => (await q<{ id: string; payload: { changed: string[] } }>(
    `SELECT id::text AS id, payload FROM domain_events
      WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'TAG_SCHEMA_UPDATED'
      ORDER BY domain_events.id`, [ws, tagId], // the bigint, not the text alias ("10" < "9")
  )).rows;

  const workspaces: string[] = [];
  // A workspace per test: module imports and module tags (#paper-review,
  // #論文 …) one test makes must not decide what another test finds.
  beforeEach(async () => {
    ws = context.workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Module tags', $1) RETURNING id`, [randomUUID()],
    )).rows[0]!.id;
    workspaces.push(ws);
    admin = await persistActor(ws, { id: "module-tags-admin", name: "Admin", role: "admin", type: "human" });
    editor = await persistActor(ws, { id: "module-tags-editor", name: "Editor", role: "editor", type: "human" });
    actor = admin;
  });
  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await deleteWorkspaceActors(workspaces);
  });

  it("importing skills creates its module tag in the given name; again keeps it; removing keeps it", async () => {
    await setModulesOn(ws, ["ai"]); // skills needs ai
    const first = await setModuleImported({ actor: admin, workspaceId: ws, module: "skills", imported: true, tagName: "#複習" });
    const views = ["canvas", "slides", "table", "calendar", "kanban", "gallery"]; // always on: the whiteboard, slides and the view modules
    expect(first.modules).toEqual(expect.arrayContaining(["skills", ...views]));
    const created = (await q<{ title: string; module: string; publish: string }>(
      `SELECT title, tag_schema->>'module' AS module, tag_schema->>'publish_collection' AS publish
         FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [first.module_tag_id],
    )).rows[0];
    expect(created).toEqual({ title: "複習", module: "skills", publish: "false" });
    const again = await setModuleImported({ actor: admin, workspaceId: ws, module: "skills", imported: true, tagName: "Review" });
    expect(again.module_tag_id).toBe(first.module_tag_id);
    const removed = await setModuleImported({ actor: admin, workspaceId: ws, module: "skills", imported: false });
    expect(removed.modules).not.toContain("skills");
    expect(removed.modules).toEqual(expect.arrayContaining(views)); // the reply also lists modules_to_confirm (#634); this is about what is on
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [first.module_tag_id])).rowCount).toBe(1);
    // A name is a top-level tag name: "/" would read as a path.
    await setModulesOn(ws, ["ai"]); // skills needs ai
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema - 'module' WHERE id = $1`, [first.module_tag_id]);
    const slashed = await setModuleImported({ actor: admin, workspaceId: ws, module: "skills", imported: true, tagName: " 複習/卡片 " });
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [slashed.module_tag_id])).rows[0]!.title).toBe("複習-卡片");
    // A module without tag abilities has no module tag.
    await setModulesOn(ws, []);
    expect(await setModuleImported({ actor: admin, workspaceId: ws, module: "rss", imported: true })).toMatchObject({ modules: ["rss", ...views] });
    await setModulesOn(ws, null);
  });

  it("an existing top-level tag named like the module tag becomes it and keeps its notes", async () => {
    const name = `Reading-${randomUUID().slice(0, 6)}`;
    const existing = await label(name);
    const member = await note([existing]);
    await setModuleImported({ actor: admin, workspaceId: ws, module: "ai", imported: true }); // skills needs it
    const result = await setModuleImported({ actor: admin, workspaceId: ws, module: "skills", imported: true, tagName: name.toLowerCase() });
    expect(result.module_tag_id).toBe(existing);
    const row = (await q<{ module: string; publish: string }>(
      `SELECT tag_schema->>'module' AS module, tag_schema->>'publish_collection' AS publish FROM content_nodes WHERE id = $1`, [existing],
    )).rows[0];
    expect(row).toEqual({ module: "skills", publish: "false" });
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [member, existing])).rowCount).toBe(1);
    expect((await schemaEvents(existing)).map((event) => event.payload.changed)).toEqual([["module"]]);
  });

  it("a tag has the functions it holds, not those of the tags it extends (decision 9: functions no longer pass down extends); a missing or trashed settings tag gives nothing", async () => {
    const [m, a, b, own, x, y, gone] = await Promise.all(Array.from({ length: 7 }, () => label()));
    await seedQ(`UPDATE content_nodes SET tag_schema = '{"module":"review"}'::jsonb WHERE id = $1`, [m]);
    // a holds review with its settings from m; b only extends a; x and y extend each other; `own` keeps its own.
    await giveFunction(ws, a!, "review", m);
    await giveFunction(ws, own!, "review");
    await giveFunction(ws, gone!, "review", randomUUID());
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_build_object('extends', jsonb_build_array($2::text)) WHERE id = $1`, [b, a]);
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_build_object('extends', jsonb_build_array($2::text)) WHERE id = $1`, [x, y]);
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_build_object('extends', jsonb_build_array($2::text)) WHERE id = $1`, [y, x]);
    const index = await functionIndex(null, ws);
    expect(index.sourceOf(a!, "review")).toBe(m);
    expect(index.sourceOf(own!, "review")).toBe(own);
    expect(index.has(b!, "review")).toBe(false); // was: inherited through a, at any depth
    expect(index.idsOf(x!)).toEqual([]);
    expect(index.has(gone!, "review")).toBe(false); // its settings tag does not exist
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [m]);
    expect((await functionIndex(null, ws)).has(a!, "review")).toBe(false);
  });

  it("extends is an admin decision that refuses itself, cycles and missing tags, and records one event per change", async () => {
    const m = await moduleTag("review");
    const course = await label();
    await expect(setTagExtends({ actor: editor, workspaceId: ws, tagId: course, extends: [m] })).rejects.toMatchObject({ name: "AuthorityError" });
    await expect(setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [course] })).rejects.toMatchObject({ status: 400 });
    await expect(setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [randomUUID()] })).rejects.toMatchObject({ status: 404 });
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [m] })).toEqual({ id: course, extends: [m] });
    // The label gained a private schema; its notes are untouched.
    const schema = (await q<{ publish: string; ext: string[] }>(
      `SELECT tag_schema->>'publish_collection' AS publish, tag_schema->'extends' AS ext FROM content_nodes WHERE id = $1`, [course],
    )).rows[0];
    expect(schema).toEqual({ publish: "false", ext: [m] });
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [m] })).toEqual({ id: course, extends: [m] });
    // One change, one event: the function reference (its extends link is part of it, not a second schema event).
    expect(await schemaEvents(course)).toHaveLength(0);
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'FUNCTION_REF_ADDED'`, [ws, course])).rowCount).toBe(1);
    const cycle = setTagExtends({ actor: admin, workspaceId: ws, tagId: m, extends: [course] });
    await expect(cycle).rejects.toBeInstanceOf(TagModuleError);
    await expect(cycle).rejects.toMatchObject({ status: 400 });
    // The route takes the whole list.
    expect((await req(`/api/tags/${course}/extends`, "PUT", { extends: [] })).status).toBe(200);
    expect((await req(`/api/tags/${course}/extends`, "PUT", { extends: ["x"] })).status).toBe(400);
  });

  it("the catalog carries the module, the extends list and effective modules", async () => {
    const m = await moduleTag("skills");
    const course = await label();
    await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [m] });
    const catalog = await readTagCatalog(admin, ws) as Array<{ id: string; schema_module: string | null; schema_extends: string[]; effective_modules: string[] }>;
    expect(catalog.find((row) => row.id === m)).toMatchObject({ schema_module: "skills", schema_extends: [], effective_modules: ["skills"] });
    expect(catalog.find((row) => row.id === course)).toMatchObject({ schema_module: null, schema_extends: [m], effective_modules: ["skills"] });
    const single = await (await req(`/api/tags/${course}`)).json() as { extends: string[]; module: string | null };
    expect(single).toMatchObject({ extends: [m], module: null });
  });

  it("a NEW extends target must be a module tag; a user tag already extended stays (D105)", async () => {
    const m = await moduleTag("skills");
    const course = await label();
    const book = await label();
    const other = await label();
    // A user tag as a new target: refused, nothing written.
    await expect(setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [book] }))
      .rejects.toMatchObject({ status: 400, message: "a tag can only extend a module tag" });
    const refused = await req(`/api/tags/${course}/extends`, "PUT", { extends: [book] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "a tag can only extend a module tag" });
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND tag_schema ? 'extends'`, [course])).rowCount).toBe(0);
    // A module tag: accepted.
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [m] })).toEqual({ id: course, extends: [m] });
    // A legacy user target already stored stays when the list is saved again,
    // with a module tag removed or added.
    await legacyExtends(course, [m, book]);
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [book] })).toEqual({ id: course, extends: [book] });
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [book, m] })).toEqual({ id: course, extends: [book, m] });
    // ...but adding another user tag is a new target.
    await expect(setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [book, m, other] })).rejects.toMatchObject({ status: 400 });
    expect((await q<{ ext: string[] }>(`SELECT tag_schema->'extends' AS ext FROM content_nodes WHERE id = $1`, [course])).rows[0]!.ext).toEqual([book, m]);
    // Dropping it is always allowed.
    expect(await setTagExtends({ actor: admin, workspaceId: ws, tagId: course, extends: [] })).toEqual({ id: course, extends: [] });
  });

  it("an extends change can be restored, but never into a cycle", async () => {
    const a = await label();
    const b = await label();
    await legacyExtends(a, [b]);
    const [created] = await schemaEvents(a);
    // The first change created the schema: that creation is not reversible.
    expect(await restoreEvent(created!.id, { actor: admin, workspaceId: ws })).toMatchObject({ code: "unsupported" });
    await setTagExtends({ actor: admin, workspaceId: ws, tagId: a, extends: [] });
    const dropped = (await schemaEvents(a)).at(-1)!;
    expect(await restoreEvent(dropped.id, { actor: admin, workspaceId: ws })).not.toHaveProperty("code");
    expect((await q<{ ext: string[] }>(`SELECT tag_schema->'extends' AS ext FROM content_nodes WHERE id = $1`, [a])).rows[0]!.ext).toEqual([b]);
    // Drop it again, let b extend a, then try to bring a → b back.
    await setTagExtends({ actor: admin, workspaceId: ws, tagId: a, extends: [] });
    const droppedAgain = (await schemaEvents(a)).at(-1)!;
    await legacyExtends(b, [a]);
    expect(await restoreEvent(droppedAgain.id, { actor: admin, workspaceId: ws })).toMatchObject({ code: "state_conflict" });
  });
});
