// The one-time repair for an inbox deleted before module tags were protected and captured into again afterwards:
// the older captures move onto the live inbox by an ordinary TAG_APPLIED event, once, and only top-level captures.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { findStrandedInboxes, moveStrandedCaptures } from "../services/strandedInboxRepair.js";
import type { ActorCtx } from "../types.js";

describe.skipIf(!isTestDatabase())("strandedInboxRepair (DB)", () => {
  let ws = "";
  let owner: ActorCtx = { id: "", name: "Owner", role: "owner", type: "human" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('stranded inbox', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, owner);
    await setWorkspaceOwner(ws, owner.id);
    await setModulesOn(ws, null);
  });

  const noteRow = async (title: string, parentId: string | null = null) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, node_type, title, slug, markdown, source_type, parent_id)
                 VALUES ($1, $2, 'content', $3, $4, $3, 'manual', $5)`, [id, ws, title, `s-${id}`, parentId]);
    return id;
  };
  const tagRow = async (title: string, deleted: boolean) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, node_type, title, slug, markdown, source_type, tag_color, tag_schema, deleted_at)
                 VALUES ($1, $2, 'class_tag', $3, $4, '', 'manual', '#888888', '{"module":"capture"}'::jsonb, ${deleted ? "now()" : "NULL"})`, [id, ws, title, `t-${id}`]);
    return id;
  };
  const link = (nodeId: string, tagId: string) => seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [nodeId, tagId]);
  const onTag = async (nodeId: string, tagId: string) => (await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [nodeId, tagId])).rowCount === 1;

  it("moves older top-level captures from the trashed inbox onto the live one, once; a capture under a note stays", async () => {
    const oldTag = await tagRow("收件匣", true), liveTag = await tagRow("收件匣 (new)", false);
    const a = await noteRow("older capture"), host = await noteRow("host note"), nested = await noteRow("under a note", host);
    await link(a, oldTag); await link(nested, oldTag);
    const [found] = await findStrandedInboxes(ws);
    expect(found).toMatchObject({ workspaceId: ws, trashedTagId: oldTag, liveTagId: liveTag, noteIds: [a] });

    expect(await moveStrandedCaptures(ws)).toEqual({ moved: 1, left: [] });
    expect(await onTag(a, liveTag)).toBe(true);
    expect(await onTag(nested, liveTag)).toBe(false);
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'TAG_APPLIED' AND target_id = $2`, [ws, a])).rowCount).toBeGreaterThan(0);
    // Once: nothing more to find or move.
    expect(await findStrandedInboxes(ws)).toEqual([]);
    expect(await moveStrandedCaptures(ws)).toEqual({ moved: 0, left: [] });
  });

  it("finds nothing in a workspace that has only a live inbox", async () => {
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('no stranded', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    expect(await findStrandedInboxes(other)).toEqual([]);
  });
});
