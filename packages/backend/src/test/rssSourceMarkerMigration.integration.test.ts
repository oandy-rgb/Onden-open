// Migration 114: RSS sources move from the reserved #subscription tag to the
// `_rss_kind = 'source'` marker, and the tag retires.
//   (a) every content note with the tag and a `_rss_url` is marked — trashed
//       sources too, so restoring one brings back a feed;
//   (b) the tag is detached from them;
//   (c) the tag loses its key; unused, it goes to the trash (restorable);
//       still applied to a note by hand, it stays live as an ordinary tag.
// Never touched: a member's nested #x/subscription, a saved article (has
// `_rss_url`, never had the tag), a note tagged by hand with no feed URL.
// Re-running changes nothing.
//
// Runs on whatever schema the test database was built from: CI's schema.sql
// (new, 114 already recorded) and, by hand, a database built from the schema
// before this change — the seeded rows are the OLD shape either way.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_KIND = "source"; // the marker value 114 writes (retired by migration 145)
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/114_rss_source_marker.sql"), "utf8");
const SCHEMA = readFileSync(resolve(here, "../../db/schema.sql"), "utf8");

describe.skipIf(!isTestDatabase())("migration 114 — RSS source marker (DB)", () => {
  const ws: Record<string, string> = {};
  const row: Record<string, string> = {};

  async function workspace(name: string) {
    ws[name] = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`,
      [name, `m114-${randomUUID()}`])).rows[0]!.id;
  }
  async function node(key: string, w: string, opts: {
    type?: string; title?: string; parent?: string; deleted?: boolean; reserved?: string; url?: string;
  } = {}) {
    row[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, deleted_at, reserved_key)
       VALUES ($1, 'rss', $2, $3, $4, '', $5, CASE WHEN $6 THEN now() END, $7) RETURNING id`,
      [ws[w], opts.type ?? "content", opts.title ?? key, `m114-${randomUUID()}`,
        opts.parent ? row[opts.parent] : null, opts.deleted ?? false, opts.reserved ?? null])).rows[0]!.id;
    if (opts.url) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_rss_url', $3)`,
        [ws[w], row[key], opts.url]);
    }
  }
  const tag = (node: string, t: string) => seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [row[node], row[t]]);
  const marker = async (key: string) => (await q<{ value: string }>(
    `SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_rss_kind'`, [row[key]])).rows[0]?.value ?? null;
  const tagsOf = async (key: string) => (await q<{ tag_id: string }>(
    `SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [row[key]])).rows.map((r) => r.tag_id);
  const state = async (key: string) => (await q<{ reserved_key: string | null; trashed: boolean }>(
    `SELECT reserved_key, deleted_at IS NOT NULL AS trashed FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!;

  beforeAll(async () => {
    // main: a keyed #subscription with a live source, a trashed source, a note
    // tagged by hand (no feed URL), a saved article (URL, no tag) and a
    // member's nested #x/subscription on a feed-looking note.
    await workspace("main");
    await node("subTag", "main", { type: "class_tag", title: "subscription", reserved: "subscription" });
    await node("source", "main", { url: "https://m114.test/a.xml" });
    await node("trashedSource", "main", { url: "https://m114.test/b.xml", deleted: true });
    await node("handTagged", "main");
    await node("article", "main", { url: "https://m114.test/a/1", parent: "source" });
    await node("x", "main", { type: "class_tag", title: "x" });
    await node("nested", "main", { type: "class_tag", title: "subscription", parent: "x" });
    await node("nestedMember", "main", { url: "https://m114.test/c.xml" });
    await tag("source", "subTag");
    await tag("trashedSource", "subTag");
    await tag("handTagged", "subTag");
    await tag("nestedMember", "nested");
    // unused: the keyed tag only marks sources, so it ends unused → trash.
    await workspace("unused");
    await node("subTag2", "unused", { type: "class_tag", title: "feeds (renamed)", reserved: "subscription" });
    await node("source2", "unused", { url: "https://m114.test/d.xml" });
    await tag("source2", "subTag2");
    // legacy: a keyless root #subscription (before the key existed) is the
    // tag by the adopt rule.
    await workspace("legacy");
    await node("legacyTag", "legacy", { type: "class_tag", title: "subscription" });
    await node("legacySource", "legacy", { url: "https://m114.test/e.xml" });
    await tag("legacySource", "legacyTag");
    await seedQ(MIGRATION);
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [Object.values(ws)]);
    await q(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [Object.values(ws)]);
  });

  it("marks every source, the trashed one too", async () => {
    expect(await marker("source")).toBe(SOURCE_KIND);
    expect(await marker("trashedSource")).toBe(SOURCE_KIND);
    expect(await marker("source2")).toBe(SOURCE_KIND);
    expect(await marker("legacySource")).toBe(SOURCE_KIND);
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_rss_url'`, [row.source])).rows[0]?.value)
      .toBe("https://m114.test/a.xml");
  });

  it("never marks an item, a hand-tagged note or a member's own #x/subscription", async () => {
    expect(await marker("article")).toBeNull();
    expect(await marker("handTagged")).toBeNull();
    expect(await marker("nestedMember")).toBeNull();
    expect(await tagsOf("nestedMember")).toEqual([row.nested]);
    expect(await state("nested")).toEqual({ reserved_key: null, trashed: false });
  });

  it("detaches the tag from the sources and un-keys it; trashes it only when unused", async () => {
    expect(await tagsOf("source")).toEqual([]);
    expect(await tagsOf("trashedSource")).toEqual([]);
    // Still applied by hand → stays live, an ordinary tag.
    expect(await tagsOf("handTagged")).toEqual([row.subTag]);
    expect(await state("subTag")).toEqual({ reserved_key: null, trashed: false });
    // Unused → in the trash (restorable), not purged.
    expect(await state("subTag2")).toEqual({ reserved_key: null, trashed: true });
    expect(await state("legacyTag")).toEqual({ reserved_key: null, trashed: true });
    const keyed = await q(`SELECT 1 FROM content_nodes WHERE workspace_id = ANY($1::uuid[]) AND reserved_key = 'subscription'`,
      [Object.values(ws)]);
    expect(keyed.rows).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const snapshot = async () => (await q(
      `SELECT n.id, n.reserved_key, n.deleted_at, (SELECT array_agg(tag_id ORDER BY tag_id) FROM node_tags WHERE node_id = n.id) AS tags,
              (SELECT value FROM node_attributes WHERE node_id = n.id AND key = '_rss_kind') AS kind
         FROM content_nodes n WHERE n.workspace_id = ANY($1::uuid[]) ORDER BY n.id`, [Object.values(ws)])).rows;
    const before = await snapshot();
    await seedQ(MIGRATION);
    expect(await snapshot()).toEqual(before);
  });

  it("the schema snapshot records 114, so a fresh database never runs it on top", () => {
    expect(SCHEMA).toContain("('114_rss_source_marker')");
    expect(SCHEMA).not.toMatch(/reserved_key IS 'Role[^']*\(task, subscription/);
  });
});
