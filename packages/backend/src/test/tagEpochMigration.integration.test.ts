// Tags carry no permission (services/readPolicy.ts), so adding or removing one
// must not move membership_epoch — that raised a "checking permissions" gate on
// every other device. Migration 094 dropped the node_tags trigger, but
// db/schema.sql still created it, so a database built from the snapshot had it.
// Migration 130 drops it either way.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const MIGRATION = readFileSync(new URL("../../db/migrations/130_drop_tag_membership_bump.sql", import.meta.url), "utf8");

// What 070 left behind (and what schema.sql used to create).
const OLD_TRIGGER = `
  CREATE FUNCTION public.bump_membership_on_node_tag() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE ws uuid;
  BEGIN
    SELECT workspace_id INTO ws FROM public.content_nodes WHERE id = COALESCE(NEW.node_id, OLD.node_id);
    IF ws IS NOT NULL THEN UPDATE public.workspaces SET membership_epoch = membership_epoch + 1 WHERE id = ws; END IF;
    RETURN NULL;
  END $$;
  CREATE TRIGGER node_tags_membership_bump AFTER INSERT OR DELETE ON public.node_tags
    FOR EACH ROW EXECUTE FUNCTION public.bump_membership_on_node_tag();`;

describe.skipIf(!isTestDatabase())("tag changes and membership_epoch (DB)", () => {
  const stamp = Date.now();
  let ws = "", nodeId = "", tagId = "";
  const epoch = async () => Number((await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [ws])).rows[0]!.e);
  const triggerCount = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_trigger WHERE tgname = 'node_tags_membership_bump'`)).rows[0]!.n);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO NOTHING`);
    ws = await getWorkspaceId();
    nodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','tag epoch node ${stamp}','tag-epoch-node-${stamp}','x') RETURNING id`, [ws])).rows[0]!.id;
    tagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','class_tag','tag epoch tag ${stamp}','tag-epoch-tag-${stamp}') RETURNING id`, [ws])).rows[0]!.id;
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM node_tags WHERE node_id = $1`, [nodeId]);
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [[nodeId, tagId]]);
  });

  it("adding and removing a tag leaves the epoch alone", async () => {
    const before = await epoch();
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [nodeId, tagId]);
    await seedQ(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [nodeId, tagId]);
    expect(await epoch()).toBe(before);
    expect(await triggerCount()).toBe(0);
  });

  it("migration 130 removes the old trigger from a database that still has it, and is safe to run again", async () => {
    await q(OLD_TRIGGER);
    const before = await epoch();
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [nodeId, tagId]);
    expect(await epoch()).toBeGreaterThan(before); // the bug, reproduced
    await seedQ(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [nodeId, tagId]);

    await q(MIGRATION);
    expect(await triggerCount()).toBe(0);
    const after = await epoch();
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [nodeId, tagId]);
    await seedQ(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [nodeId, tagId]);
    expect(await epoch()).toBe(after);

    await q(MIGRATION); // nothing left to drop
    expect(await triggerCount()).toBe(0);
  });
});
