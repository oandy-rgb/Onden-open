// Reserved tags are found by role (content_nodes.reserved_key, migration 100),
// not by title: renaming one keeps it working, and a member's nested tag of
// the same title (#project/page) is an ordinary tag.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { adoptReservedTag, reservedTagId, RESERVED_TAGS } from "../services/reservedTags.js";
import { findConfigNodeId } from "../services/siteConfig.js";
import { isWorkspaceConfigNode, NOT_SYSTEM_NODE_SQL } from "../spine/reservedNodes.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

// Each test gets an empty workspace of its own: they adopt, rename and break
// the workspace's reserved tags (#page, the config tag), which they may not do
// to the shared default workspace, and adoption needs a workspace with none.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("reserved tags by key (DB)", () => {
  // The member's parent tag (#…/page). Not "project": a migrate-built database
  // already has a root #project (seeded tag library), and root titles are unique.
  const PARENT = "rt-project";

  async function tag(title: string, parentId: string | null = null): Promise<string> {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, parent_id)
       VALUES ($1, 'manual', 'class_tag', $2, $3, $4) RETURNING id`,
      [WS, title, `rt-${title}-${Math.random().toString(36).slice(2, 8)}`, parentId],
    );
    return r.rows[0]!.id;
  }

  beforeEach(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Reserved tags', $1) RETURNING id`, [`rt-${randomUUID()}`])).rows[0]!.id;
  });

  it("adopts a hand-made root #page once, and not a nested one", async () => {
    const parent = await tag(PARENT);
    const nested = await tag("page", parent);
    expect(await adoptReservedTag(WS, RESERVED_TAGS.page)).toBeNull();

    const root = await tag("page");
    expect(await adoptReservedTag(WS, RESERVED_TAGS.page)).toBe(root);
    expect(await reservedTagId(WS, RESERVED_TAGS.page)).toBe(root);
    // Already held: a second root of that title is not adopted.
    await seedQ(`UPDATE content_nodes SET title = 'renamed' WHERE id = $1`, [root]);
    await tag("page");
    expect(await adoptReservedTag(WS, RESERVED_TAGS.page)).toBeNull();
    expect(await reservedTagId(WS, RESERVED_TAGS.page)).toBe(root);
    expect(nested).not.toBe(root);
  });

  it("lists hide the config tag by its key only: renamed, it stays hidden; a member's #x/workspace-config lists (T5)", async () => {
    await ensureConfigNode(WS);
    const tagId = (await reservedTagId(WS, RESERVED_TAGS.config))!;
    const original = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.title;
    try {
      await seedQ(`UPDATE content_nodes SET title = 'Site settings' WHERE id = $1`, [tagId]);
      const nested = await tag("workspace-config", await tag("reading"));
      const listed = async (id: string) => (await q(
        `SELECT 1 FROM content_nodes n WHERE n.id = $1 AND ${NOT_SYSTEM_NODE_SQL("n")}`, [id])).rows.length > 0;
      expect(await listed(tagId)).toBe(false);
      expect(await listed(nested)).toBe(true);
      // Trashed, the config tag is still guarded (lifecycle "any").
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [tagId]);
      expect(await listed(tagId)).toBe(false);
    } finally {
      await seedQ(`UPDATE content_nodes SET title = $2, deleted_at = NULL WHERE id = $1`, [tagId, original]);
    }
  });

  it("site config never takes over an ordinary tag holding the config tag's old slug (T5)", async () => {
    const configNode = await ensureConfigNode(WS);
    const tagId = (await reservedTagId(WS, RESERVED_TAGS.config))!;
    const before = (await q<{ title: string; slug: string }>(`SELECT title, slug FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!;
    // The config tag's row is gone from view (flipped by the old PATCH bug),
    // and an ordinary tag holds the slug the old upsert conflicted on.
    await seedQ(`UPDATE content_nodes SET node_type = 'content', slug = $2 WHERE id = $1`, [tagId, `rt-config-${Date.now()}`]);
    const squatter = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1, 'manual', 'class_tag', 'rt-squatter', 'tag-workspace-config') RETURNING id`, [WS])).rows[0]!.id;
    try {
      // The Site Config note stays live (the real corruption): the healed
      // tag's note is returned, not a second one inserted.
      const recreated = await ensureConfigNode(WS);
      expect(recreated).toBe(configNode);
      // The keyed row is healed back to a class_tag and holds the settings again…
      expect((await q<{ node_type: string }>(`SELECT node_type FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.node_type).toBe("class_tag");
      expect(await reservedTagId(WS, RESERVED_TAGS.config)).toBe(tagId);
      expect(await isWorkspaceConfigNode(recreated)).toBe(true);
      // …and the ordinary tag is untouched.
      const other = (await q<{ reserved_key: string | null }>(`SELECT reserved_key FROM content_nodes WHERE id = $1`, [squatter])).rows[0]!;
      expect(other.reserved_key).toBeNull();
      expect(await isWorkspaceConfigNode(squatter)).toBe(false);
    } finally {
      await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [squatter]);
      await seedQ(`UPDATE content_nodes SET node_type = 'class_tag', title = $2, slug = $3 WHERE id = $1`, [tagId, before.title, before.slug]);
    }
  });

  it("site config: a renamed config tag still holds the settings; a legacy one is adopted, not duplicated", async () => {
    const configNode = await ensureConfigNode(WS);
    const tagId = await reservedTagId(WS, RESERVED_TAGS.config);
    expect(tagId).toBeTruthy();
    const original = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.title;
    try {
      await seedQ(`UPDATE content_nodes SET title = '網站設定' WHERE id = $1`, [tagId]);
      expect(await findConfigNodeId(WS)).toBe(configNode);
      expect(await isWorkspaceConfigNode(configNode)).toBe(true);
      // A member's nested tag of that title is ordinary.
      const parent = await tag(PARENT);
      const nested = await tag("workspace-config", parent);
      expect(await isWorkspaceConfigNode(nested)).toBe(false);

      // Legacy: the key is gone (a restored backup) — adopted, same note.
      // Until then a title proves nothing (T5): the guard follows the key.
      await seedQ(`UPDATE content_nodes SET title = $2, reserved_key = NULL WHERE id = $1`, [tagId, original]);
      expect(await findConfigNodeId(WS)).toBeNull();
      expect(await isWorkspaceConfigNode(configNode)).toBe(false);
      expect(await ensureConfigNode(WS)).toBe(configNode);
      expect(await isWorkspaceConfigNode(configNode)).toBe(true);
      expect(await reservedTagId(WS, RESERVED_TAGS.config)).toBe(tagId);
    } finally {
      await seedQ(`UPDATE content_nodes SET title = $2, reserved_key = $3 WHERE id = $1`, [tagId, original, RESERVED_TAGS.config]);
    }
  });
});
