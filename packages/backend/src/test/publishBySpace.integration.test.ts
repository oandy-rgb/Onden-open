// The site is a space's notes (owner 2026-11-10, modules/website/publishing/publishedSet.ts): in a space whose
// 「發布到網站」 is on, every note is on the site unless kept off — by its own 「不發布」 (`_published` 'false'), because
// it is blank, or because it is an article saved from a feed; 「發布」 ('true') brings those on anyway. The preview
// names each note kept off and why, the home falls back to the top note of the space with the most pages, a copy
// keeps a 「不發布」, and migration 186 turns the switch off where it never published anything.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import type { PublishPreview } from "@onden/contract";
import { seedQ } from "./helpers/seedQ.js";

let WS = "";
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getWorkspaceId: async () => WS,
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const MIGRATION_186 = readFileSync(new URL("../../db/migrations/186_publish_by_space.sql", import.meta.url), "utf8");

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);
const preview = async () => (await (await app.request("/api/publish/preview", {
  method: "POST", body: JSON.stringify({ title: "Site" }), headers: { "Content-Type": "application/json" },
})).json()) as PublishPreview;
const onSite = (p: PublishPreview) => (p.site.payload.nodes as Array<{ id: string }>).map((n) => n.id).sort();

describe.skipIf(!isTestDb)("publishing by space (DB)", () => {
  let owner: ActorCtx;
  let site = "", closed = "";
  beforeEach(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('By space', $1) RETURNING id::text`, [`by-space-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "owner-by-space", name: "Owner", role: "admin", type: "human" });
    site = await makeSpace(WS, `網站 ${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    closed = await makeSpace(WS, `closed ${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    currentActor = owner;
  });

  async function note(title: string, opts: { space?: string; markdown?: string; flag?: "true" | "false"; source?: string; parent?: string; attr?: string } = {}): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1,$2,'content',$3,$4,$5,$6) RETURNING id::text`,
      [WS, opts.source ?? "manual", title, randomUUID().slice(0, 8), opts.markdown ?? "words", opts.parent ?? null])).rows[0]!.id;
    await putInSpace(id, opts.space ?? site);
    if (opts.flag) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published',$3,'bool')`, [WS, id, opts.flag]);
    if (opts.attr) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1,$2,$3,'x')`, [WS, id, opts.attr]);
    return id;
  }

  it("every note of a space that publishes is on the site; one kept off, blank or saved from a feed is not, and the preview says why", async () => {
    const plain = await note("Plain");
    const keptOff = await note("Kept off", { flag: "false" });
    const blank = await note("Blank", { markdown: "  \n" });
    const article = await note("Saved article", { source: "rss" });
    const inClosed = await note("Elsewhere", { space: closed });
    const p = await preview();
    expect(onSite(p)).toEqual([plain]);
    const reasons = Object.fromEntries((p.left_out ?? []).map((n) => [n.node_id, n.reason]));
    expect(reasons).toEqual({ [keptOff]: "kept_off", [blank]: "blank", [article]: "saved_article" });
    expect(reasons).not.toHaveProperty(inClosed); // a space that does not publish is not the site's business
  });

  it("a subscription note from before feeds became settings (`_rss_kind` = source) is left out like a saved article, and the preview says so", async () => {
    const feed = await note("Reader feed", { markdown: "Subscribed feed: https://example.test/feed.xml\n", attr: "_rss_kind" });
    await seedQ(`UPDATE node_attributes SET value = 'source' WHERE node_id = $1 AND key = '_rss_kind'`, [feed]);
    const plain = await note("Plain");
    const p = await preview();
    expect(onSite(p)).toEqual([plain]);
    expect(p.left_out).toEqual([expect.objectContaining({ node_id: feed, reason: "saved_article" })]);
  });

  it("a page is dated by the last edit of its content, else its creation — not by a move, a tag or an import that touched the row", async () => {
    const edited = await note("Edited");
    const untouched = await note("Untouched");
    await seedQ(`UPDATE content_nodes SET created_at = '2026-01-05T00:00:00Z', updated_at = '2026-11-07T00:00:00Z' WHERE id = ANY($1::uuid[])`, [[edited, untouched]]);
    await seedQ(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
       VALUES ($1, 'user', $2, 'NODE_UPDATED', 'node', $3, '{"body_hash":"h"}'::jsonb, '2026-03-02T09:00:00Z')`,
      [WS, owner.id, edited]);
    const dated = Object.fromEntries(((await preview()).site.payload.nodes as Array<{ id: string; updated_at: string }>).map((n) => [n.id, n.updated_at.slice(0, 10)]));
    expect(dated[edited]).toBe("2026-03-02");
    expect(dated[untouched]).toBe("2026-01-05");
  });

  it("「發布」 brings a blank note or a saved article on; in a space that does not publish it does nothing", async () => {
    const blank = await note("Blank", { markdown: "", flag: "true" });
    const article = await note("Saved article", { source: "rss", flag: "true" });
    const marked = await note("Marked elsewhere", { space: closed, flag: "true" });
    const p = await preview();
    expect(onSite(p)).toEqual([blank, article].sort());
    expect(p.left_out).toEqual([expect.objectContaining({ node_id: marked, reason: "space_not_published" })]);
  });

  it("a note with no words is not blank when a note sits under it or it keeps something beside the text", async () => {
    const parent = await note("Section", { markdown: "" });
    const child = await note("Child", { parent });
    const inked = await note("Drawing", { markdown: "", attr: "ink_data" });
    expect(onSite(await preview())).toEqual([parent, child, inked].sort());
  });

  it("with no home named, the site opens on the top note of the space with the most pages", async () => {
    const other = await makeSpace(WS, `other ${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    await note("Lone page", { space: other }); // first in site order, but its space has one page
    const root = await note("資工主內容");
    await note("作業系統", { parent: root });
    await note("線性代數", { parent: root });
    expect((await preview()).site.home_node_id).toBe(root);
  });

  it("a copy keeps a 「不發布」 and drops a 「發布」", async () => {
    const off = await note("Off", { flag: "false" });
    const on = await note("On", { markdown: "", flag: "true" });
    const flagOf = async (id: string) => (await q<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [id])).rows[0]?.value ?? null;
    const copyOf = async (sourceId: string) => String((await duplicateNote({ workspaceId: WS, actor: owner, sourceId })).node.id);
    expect(await flagOf(await copyOf(off))).toBe("false");
    expect(await flagOf(await copyOf(on))).toBeNull();
  });

  it("migration 186: a switch that never published anything goes off, one that did stays on; a new workspace's default space starts off", async () => {
    const unused = await makeSpace(WS, `unused ${randomUUID()}`, [], { publish: true, external_ai: false, backup: true });
    await note("Never marked", { space: unused });
    await note("Marked", { flag: "true" }); // in `site`
    // The migration touches every workspace: run it on one connection and roll it back, so the other test files
    // sharing this database never see it.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(MIGRATION_186);
      const publishes = async (id: string) => (await client.query<{ on: boolean }>(
        `SELECT capabilities->>'publish' = 'true' AS on FROM spaces WHERE id = $1`, [id])).rows[0]!.on;
      expect(await publishes(unused)).toBe(false);
      expect(await publishes(site)).toBe(true);
      const fresh = (await client.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Fresh', $1) RETURNING id::text`, [`fresh-${randomUUID()}`])).rows[0]!.id;
      expect((await client.query<{ publish: string }>(
        `SELECT capabilities->>'publish' AS publish FROM spaces WHERE workspace_id = $1 AND is_default`, [fresh])).rows[0]!.publish).toBe("false");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
