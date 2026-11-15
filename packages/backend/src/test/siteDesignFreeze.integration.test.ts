// P1b: the site design v2 is stored with the chrome, and a publish freezes what
// the home page and tag pages list (docs/architecture/proposals/publish-redesign-2026-10-24.md §5).
//   * a v2 chrome is cleaned by validateDesign on write and read back, with the
//     `rev` guard unchanged;
//   * the design always comes from the saved chrome, never from the request;
//   * tag_view / timeline rows (`resolved`) and `tag_pages` hold published notes only;
//   * a home-page note that is not published is reported to the preview only;
//   * a takedown shows in /api/site at once, without a new publish;
//   * POST /api/publish/include is the owner's.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import workspaceRouter from "../routes/workspace.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedViewElements } from "./helpers/seedView.js";
import { setChrome } from "./helpers/siteConfigFixture.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/workspace", workspaceRouter);
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let owner: ActorCtx = { id: "p1b-owner", name: "Owner", role: "admin", type: "human" };
let member: ActorCtx = { id: "p1b-member", name: "Member", role: "editor", type: "human" };

type Row = { id: string; title: string; slug: string; date: string; fields: Record<string, string | null>; image: string; excerpt: string };
type Design = {
  v: 3; preset: string | null; boxes: Record<string, unknown>; legacy_home: { content: Array<{ type: string; props: { items: Array<{ type: string; props: Record<string, unknown> }> } }> } | null; css: string;
  resolved: Record<string, Row[]>;
  tag_pages: Record<string, { name: string; slug: string; viewKind: string; rows: Row[] }>;
  tag_names: Record<string, string>;
};
type Site = { payload: { presentation: { design: Design; blocks?: unknown; template?: unknown; pageLayouts?: unknown } } };

describe.skipIf(!isTestDb)("site design v2: stored with the chrome, frozen at publish (P1b)", () => {
  let tagId = "";
  let viewId = "";
  let spaceId = "";
  const note: Record<"alpha" | "bravo" | "charlie" | "delta" | "secret", string> = { alpha: "", bravo: "", charlie: "", delta: "", secret: "" };

  const addNote = async (title: string, createdAt: string, markdown: string, status: string | null, tagged = true): Promise<string> => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at)
       VALUES ($1,'manual','content',$2,$3,$4,$5) RETURNING id::text`,
      [workspaceId, title, title.toLowerCase().replace(/\s+/g, "-"), markdown, createdAt])).rows[0]!.id;
    await putInSpace(id, spaceId);
    if (tagged) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    if (status) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'status',$3,'text','explicit')`, [workspaceId, id, status]);
    }
    return id;
  };
  const setPublished = async (id: string, on: boolean) =>
    expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: on ? "true" : "false", value_type: "bool" })).status).toBe(200);
  const saveDesign = async (design: Record<string, unknown>) => {
    const config = await (await app.request("/api/workspace/config")).json() as { chrome: { rev?: string } | null };
    const res = await send("/api/workspace/config", "PATCH", {
      chrome: { v: 2, studio_draft: true, rev: randomUUID(), ...design }, chrome_base: config.chrome?.rev ?? null,
    });
    expect(res.status).toBe(200);
  };
  const homeDesign = (extra: Record<string, unknown> = {}) => ({
    home: { root: { props: {} }, content: [{ type: "stack", props: { id: "stack-a", items: [
      { type: "tag_view", props: { id: "c-new", tagId, viewId, viewKind: "list", limit: 2, sort: "new" } },
      { type: "tag_view", props: { id: "c-title", tagId, viewId, viewKind: "table", limit: 1, sort: "title" } },
      { type: "timeline", props: { id: "c-time", tagId, limit: 2 } },
      { type: "note", props: { id: "c-note", noteId: note.secret, blockId: "", display: "full" } },
    ] } }] },
    ...extra,
  });
  const previewBody = { title: "Site" };
  const preview = async () => await (await send("/api/publish/preview", "POST", previewBody)).json() as {
    hash: string; diff: { settings_changed: boolean; added: Array<{ id: string }> };
    unpublished_refs: Array<{ componentId: string; noteId: string; title: string }>; site: Site;
  };
  const publishNow = async () => {
    const { hash } = await preview();
    expect((await send("/api/publish", "POST", { ...previewBody, preview_hash: hash })).status).toBe(201);
  };
  const stored = async (): Promise<Site> => ({ payload: (await q<{ payload: Site["payload"] }>(
    `SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [workspaceId])).rows[0]!.payload });
  const served = async (): Promise<Site> => {
    const res = await app.request("/api/site");
    expect(res.status).toBe(200);
    return res.json() as Promise<Site>;
  };

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('P1b',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    member = await persistActor(workspaceId, member);
    currentActor = owner;
    spaceId = await makeSpace(workspaceId, `pub-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    viewId = randomUUID();
    tagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color)
       VALUES ($1,'manual','class_tag','Garden','tag-garden-p1b','','#888888') RETURNING id::text`,
      [workspaceId])).rows[0]!.id;
    await seedViewElements(tagId, [{
      id: viewId, name: "Table", layout: "table", filters: [], sorts: [{ field: "title", dir: "asc" }],
      group_by: null, visible_fields: ["status"], layout_config: {}, pin_order: 0,
    }]);
    note.alpha = await addNote("Alpha", "2026-10-01T12:00:00Z", "Alpha body.", "idea");
    note.bravo = await addNote("Bravo", "2026-10-02T12:00:00Z", "Bravo body.", "wip");
    note.charlie = await addNote("Charlie", "2026-10-03T12:00:00Z", "![c](/api/media/c.png)\n\nCharlie body.", "done");
    // Not published (yet): in the tag, newest of all.
    note.delta = await addNote("Delta", "2026-10-04T12:00:00Z", "Delta body.", "idea");
    // Not published and not in the tag: only the home page names it.
    note.secret = await addNote("Secret Draft", "2026-10-05T12:00:00Z", "Private words.", null, false);
    for (const id of [note.alpha, note.bravo, note.charlie]) await setPublished(id, true);
    // The space publishes, so the two not published yet are kept off (「不發布」).
    for (const id of [note.delta, note.secret]) await setPublished(id, false);
  });

  it("a v2 design is cleaned on write and read back; the rev guard still refuses a stale save", async () => {
    currentActor = owner;
    await saveDesign({
      css: ".a { color: red }",
      home: { root: { props: {} }, content: [
        { type: "bogus", props: { id: "x" } },
        { type: "stack", props: { id: "s1", items: [{ type: "tag_view", props: { id: "tv", tagId, limit: 99, sort: "random" } }] } },
      ] },
    });
    const read = await (await app.request("/api/workspace/config")).json() as { chrome: { v: number; rev: string; css: string; studio_draft: boolean; legacy_home: { content: Array<{ type: string; props: { items: Array<{ props: Record<string, unknown> }> } }> } } };
    expect(read.chrome.v).toBe(3); // a v2 design is moved to v3 on write (siteConfig cleanedChrome)
    expect(read.chrome.studio_draft).toBe(true);
    expect(read.chrome.css).toBe(".a { color: red }");
    expect(read.chrome.legacy_home.content.map((c) => c.type)).toEqual(["stack"]); // the unknown type is gone
    expect(read.chrome.legacy_home.content[0]!.props.items[0]!.props).toMatchObject({ limit: 12, sort: "new" }); // clamped, defaulted

    // A save that names a revision which is no longer the stored one is refused.
    const stale = await send("/api/workspace/config", "PATCH", { chrome: { v: 2, rev: randomUUID() }, chrome_base: randomUUID() });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error?: string }).error).toBe("design_stale");
    expect(((await (await app.request("/api/workspace/config")).json()) as { chrome: { rev: string } }).chrome.rev).toBe(read.chrome.rev);
  });

  it("publish freezes tag_view and timeline rows: published notes only, limit and sort honoured, exact row shape", async () => {
    currentActor = owner;
    await saveDesign(homeDesign());
    await publishNow();
    const { resolved, tag_pages, tag_names } = (await stored()).payload.presentation.design;

    // tag_view, sort "new", limit 2: newest published first. Delta (newest) is not published.
    const [charlie, bravo] = resolved["c-new"]!;
    expect(charlie).toEqual({
      id: note.charlie, title: "Charlie", slug: "charlie", date: "2026-10-03",
      fields: { status: "done" }, image: "/api/media/c.png", excerpt: "Charlie body.",
    });
    expect(bravo).toEqual({
      id: note.bravo, title: "Bravo", slug: "bravo", date: "2026-10-02",
      fields: { status: "wip" }, image: "", excerpt: "Bravo body.",
    });
    expect(resolved["c-new"]).toHaveLength(2);
    // sort "title", limit 1.
    expect(resolved["c-title"]!.map((r) => r.title)).toEqual(["Alpha"]);
    // timeline: members newest first, no view fields.
    expect(resolved["c-time"]!.map((r) => r.title)).toEqual(["Charlie", "Bravo"]);
    expect(resolved["c-time"]![0]!.fields).toEqual({});
    // Nothing unpublished anywhere in the frozen design.
    expect(JSON.stringify(resolved)).not.toContain("Delta");
    expect(resolved["c-note"]).toBeUndefined();

    // The tag page: the first saved view over published members, the tag's name and a URL slug.
    expect(tag_pages[tagId]).toMatchObject({ name: "Garden", slug: "garden", viewKind: "table" });
    expect(tag_pages[tagId]!.rows.map((r) => r.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(tag_names[tagId]).toBe("Garden");
    // The old Studio's fields are not in a new snapshot.
    const presentation = (await stored()).payload.presentation;
    for (const key of ["blocks", "pageBlocks", "pageLayouts", "template", "site_pages"]) expect(presentation).not.toHaveProperty(key);
  });

  it("content on the top level (no layout around it) is saved as it is and frozen with its rows", async () => {
    currentActor = owner;
    await saveDesign({
      home: { root: { props: {} }, content: [
        { type: "tag_view", props: { id: "flat-view", tagId, viewId, viewKind: "list", limit: 1, sort: "title" } },
        { type: "stack", props: { id: "stack-b", items: [{ type: "timeline", props: { id: "flat-time", tagId, limit: 2 } }] } },
        { type: "note", props: { id: "flat-note", noteId: note.secret, blockId: "", display: "full" } },
      ] },
    });
    const chrome = await (await app.request("/api/workspace/config")).json() as { chrome: { legacy_home: { content: Array<{ type: string; props: { id: string } }> } } };
    expect(chrome.chrome.legacy_home.content.map((c) => `${c.type}:${c.props.id}`)).toEqual(["tag_view:flat-view", "stack:stack-b", "note:flat-note"]);
    await publishNow();
    const { resolved } = (await stored()).payload.presentation.design;
    expect(resolved["flat-view"]!.map((r) => r.title)).toEqual(["Alpha"]);
    expect(resolved["flat-time"]!.map((r) => r.title)).toEqual(["Charlie", "Bravo"]);
    // the unpublished note on the top level is still reported to the preview only
    expect((await preview()).unpublished_refs.map((r) => r.componentId)).toContain("flat-note");
  });
  it("the design comes from the saved chrome, not from the request body", async () => {
    currentActor = owner;
    await saveDesign({ css: ".saved { color: red }" });
    const body = { title: "Site", presentation: { design: { v: 2, css: ".sent { color: blue }" }, blocks: [{ type: "hero" }] } };
    const { hash } = await (await send("/api/publish/preview", "POST", body)).json() as { hash: string };
    expect((await send("/api/publish", "POST", { ...body, preview_hash: hash })).status).toBe(201);
    const presentation = (await stored()).payload.presentation;
    expect(presentation.design.css).toBe(".saved { color: red }");
    expect(presentation).not.toHaveProperty("blocks");
  });

  it("a home-page note that is not published is listed in the preview only; its title and id never reach the payload or /api/site", async () => {
    currentActor = owner;
    await saveDesign(homeDesign());
    const p = await preview();
    expect(p.unpublished_refs).toEqual([{ componentId: "c-note", noteId: note.secret, title: "Secret Draft" }]);
    expect(JSON.stringify(p.site)).not.toContain("Secret Draft");
    await publishNow();
    expect(JSON.stringify((await stored()).payload)).not.toContain("Secret Draft");
    expect(JSON.stringify(await served())).not.toContain("Secret Draft");
    // The component stays with its note emptied (scrubHomeNotes); the renderer shows nothing.
    expect(JSON.stringify((await stored()).payload)).not.toContain(note.secret);
    expect(JSON.stringify(await served())).not.toContain(note.secret);
    expect(JSON.stringify((await served()).payload.presentation.design.legacy_home)).toContain('"id":"c-note","noteId":""');
  });

  it("a takedown after publish removes the note from resolved and tag_pages in /api/site at once", async () => {
    currentActor = owner;
    await saveDesign(homeDesign());
    await publishNow();
    const before = (await served()).payload.presentation.design;
    expect(before.resolved["c-new"]!.map((r) => r.id)).toContain(note.charlie);
    try {
      await setPublished(note.charlie, false);
      const after = (await served()).payload.presentation.design;
      expect(after.resolved["c-new"]!.map((r) => r.id)).toEqual([note.bravo]);
      expect(after.resolved["c-time"]!.map((r) => r.id)).toEqual([note.bravo]);
      expect(after.tag_pages[tagId]!.rows.map((r) => r.id)).not.toContain(note.charlie);
      expect(JSON.stringify(after)).not.toContain("Charlie");

      // A tag hidden since leaves the site with its page and its name.
      await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [tagId]);
      const hidden = (await served()).payload.presentation.design;
      expect(hidden.tag_pages).toEqual({});
      expect(hidden.tag_names).toEqual({});
    } finally {
      await seedQ(`UPDATE content_nodes SET hidden = false WHERE id = $1`, [tagId]);
      await setPublished(note.charlie, true);
    }
  });

  it("without a saved design the snapshot carries the default design: the 簡單 boxes, no free-form home page (a chrome without v: 2 or 3 is never rendered)", async () => {
    currentActor = owner;
    for (const chrome of [null, { blocks: [{ type: "hero", props: { title: "old studio" } }], studio_draft: true }]) {
      await setChrome(workspaceId, chrome);
      await publishNow();
      const design = (await stored()).payload.presentation.design;
      expect(design.v).toBe(3);
      expect(design.preset).toBe("simple");
      expect(design.legacy_home).toBeNull();
      expect(design.boxes["home.hero"]).toEqual({ widget: "intro", variant: "paragraph" });
      expect(design.resolved).toEqual({});
      expect(Object.keys(design.tag_pages).length).toBeGreaterThan(0); // the tag pages the topics list links to
      expect(JSON.stringify((await stored()).payload.presentation)).not.toContain("old studio");
    }
  });

  it("a new published note under a tag on the home page changes the hash and shows as a settings change", async () => {
    currentActor = owner;
    await saveDesign(homeDesign());
    await publishNow();
    const before = await preview();
    expect(before.diff.settings_changed).toBe(false);
    try {
      await setPublished(note.delta, true);
      const after = await preview();
      expect(after.hash).not.toBe(before.hash);
      expect(after.diff.settings_changed).toBe(true);
      expect(after.diff.added.map((n) => n.id)).toEqual([note.delta]);
      expect(after.site.payload.presentation.design.resolved["c-new"]![0]!.title).toBe("Delta");
    } finally {
      await setPublished(note.delta, false);
    }
  });

  it("POST /api/publish/include publishes the listed notes for the owner and answers 403 to a member", async () => {
    currentActor = member;
    expect((await send("/api/publish/include", "POST", { noteIds: [note.secret] })).status).toBe(403);
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = '_published' AND value = 'true'`, [note.secret])).rows).toHaveLength(0);

    currentActor = owner;
    try {
      const res = await send("/api/publish/include", "POST", { noteIds: [note.secret, note.secret] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ published: [note.secret], failed: [] });
      expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = '_published' AND value = 'true'`, [note.secret])).rows).toHaveLength(1);
      // Now the home page's note component is no longer an unpublished reference.
      await saveDesign(homeDesign());
      expect((await preview()).unpublished_refs).toEqual([]);
    } finally {
      await setPublished(note.secret, false);
    }
    expect((await send("/api/publish/include", "POST", { noteIds: [] })).status).toBe(400);
  });
});
