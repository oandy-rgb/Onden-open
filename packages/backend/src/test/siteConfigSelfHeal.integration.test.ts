// getConfigNodeId self-heal — the workspace-config class_tag must survive a
// type-flip without wedging every getSiteConfig() caller (bootstrap, /api/site).
//
// The real incident: on 2026-06-27 a PATCH flipped the config class_tag to
// node_type='content' (the pre-fix zod-default PATCH bug, fixed in 36069e3).
// After that, getConfigNodeId's `found` JOIN — which requires the config tag be
// a class_tag — missed it and fell into the defensive create path, which then
// collided on a unique index → 500 on EVERY request, forever.
//
// The config tag is found by its reserved_key (T5): the defensive INSERT
// conflicts on the live reserved-key index, coerces the flipped keyed row back
// to a class_tag, and the Site Config note still carrying it is returned
// rather than a second one inserted (its '_workspace_config' slug would
// collide). A note that merely holds the old 'tag-workspace-config' slug or
// title is an ordinary note and stays one.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { findConfigNodeId } from "../services/siteConfig.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const CONFIG_TITLE = "workspace-config";
const CONFIG_SLUG = "tag-workspace-config";

describe.skipIf(!isTestDb)("getConfigNodeId self-heal (DB)", () => {
  let WS = "";

  beforeEach(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // Clean slate for the config nodes so each case starts from a known state:
    // the config tag (by its key — its slug is tag-workspace-config-<id6>),
    // the Site Config note, and any squatter on the old fixed slug.
    await seedQ(
      `DELETE FROM content_nodes WHERE workspace_id = $1
          AND (slug = $2 OR slug = '_workspace_config' OR reserved_key = 'workspace-config')`,
      [WS, CONFIG_SLUG],
    );
  });

  it("a note squatting the config tag's slug no longer blocks it (slugs are per space)", async () => {
    // Reproduce the 2026-06-27 corruption: a LIVE content node squatting the
    // config tag's title+slug, with no valid class_tag config in place.
    const bad = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id`,
      [WS, CONFIG_TITLE, CONFIG_SLUG],
    );
    const badId = bad.rows[0]!.id;

    // Before the fix this threw (duplicate key on the slug index). Since
    // migration 099 a note in a space no longer shares the tag namespace, so
    // the squatter cannot collide: a real config class_tag is created and the
    // squatter stays an ordinary note.
    const nodeId = await ensureConfigNode(WS);
    expect(nodeId).toBeTruthy();
    const squatter = await q<{ node_type: string }>(`SELECT node_type FROM content_nodes WHERE id = $1`, [badId]);
    expect(squatter.rows[0]?.node_type).toBe("content");

    const count = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes
        WHERE workspace_id = $1 AND title = $2 AND node_type = 'class_tag' AND deleted_at IS NULL`,
      [WS, CONFIG_TITLE],
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("a flipped config tag whose Site Config note is still live heals to the same note", async () => {
    const nodeId = await ensureConfigNode(WS);
    const tagId = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND reserved_key = 'workspace-config'`, [WS])).rows[0]!.id;
    // The 2026-06-27 corruption: the tag flipped, the note untouched and live.
    await seedQ(`UPDATE content_nodes SET node_type = 'content' WHERE id = $1`, [tagId]);
    expect(await ensureConfigNode(WS)).toBe(nodeId);
    expect(await ensureConfigNode(WS)).toBe(nodeId);
    const tag = await q<{ node_type: string }>(`SELECT node_type FROM content_nodes WHERE id = $1`, [tagId]);
    expect(tag.rows[0]?.node_type).toBe("class_tag");
    const notes = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1 AND slug = '_workspace_config' AND deleted_at IS NULL`, [WS]);
    expect(notes.rows[0]?.n).toBe("1");
  });

  it("is idempotent: repeated calls return the same config node and never throw", async () => {
    const a = await ensureConfigNode(WS);
    const b = await ensureConfigNode(WS);
    const c = await ensureConfigNode(WS);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("creates the config node cleanly on a pristine workspace", async () => {
    const nodeId = await ensureConfigNode(WS);
    expect(nodeId).toBeTruthy();
    const node = await q<{ title: string; node_type: string }>(
      `SELECT title, node_type FROM content_nodes WHERE id = $1`, [nodeId],
    );
    expect(node.rows[0]?.node_type).toBe("content");
    expect(node.rows[0]?.title).toBe("Site Config");
  });
  // A note a member tagged #workspace-config by hand is not the Site Config
  // note, even when it is older. Both lookups pick the '_workspace_config'
  // note, and the plain lookup is deterministic (it used to LIMIT 1 unordered).
  const strayTaggedNote = async (tagId: string): Promise<string> => {
    const stray = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at)
       VALUES ($1, 'manual', 'content', 'stray', $2, '', now() - interval '1 day') RETURNING id`,
      [WS, `stray-config-${Date.now()}`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [stray, tagId]);
    return stray;
  };
  const configTagId = async (): Promise<string> => (await q<{ id: string }>(
    `SELECT id FROM content_nodes WHERE workspace_id = $1 AND reserved_key = 'workspace-config'`, [WS])).rows[0]!.id;

  it("healing a flipped config tag adopts the Site Config note, not an older stray tagged note", async () => {
    const nodeId = await ensureConfigNode(WS);
    const tagId = await configTagId();
    await strayTaggedNote(tagId);
    await seedQ(`UPDATE content_nodes SET node_type = 'content' WHERE id = $1`, [tagId]);
    expect(await ensureConfigNode(WS)).toBe(nodeId);
  });

  it("findConfigNodeId prefers the Site Config note over a stray tagged note", async () => {
    const nodeId = await ensureConfigNode(WS);
    await strayTaggedNote(await configTagId());
    for (let i = 0; i < 3; i++) expect(await findConfigNodeId(WS)).toBe(nodeId);
  });
});
