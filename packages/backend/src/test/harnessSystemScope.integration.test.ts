// System machinery never reaches a model (D54 follow-up). A source_type='system'
// note (the Site Config kind) and the workspace-config tag are configuration,
// not notes: every AI scope — search, nodes, tag, board (through the same
// numbered-notes gate as nodes) — and the notes tools (aiReadable) leave them
// out by reservedNodes.NOT_SYSTEM_NODE_SQL, the rule /api/query and saved views
// list by. Here the system rows are readable and in an external-AI space, so
// only that rule can keep them out.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { aiReadable, gatherNodes, gatherSearch, gatherTag, ScopeUnavailable } from "../services/harness/scope.js";
import { searchNodes } from "../services/nodeSearch.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

describe.skipIf(!isTestDb)("a system note is never in an AI scope (DB)", () => {
  let workspaceId = "";
  let actor: ActorCtx = { id: "sys-scope-admin", name: "Admin", role: "admin", type: "human" };
  const word = `quillwort${Date.now()}`;
  const ids = { tag: "", note: "", system: "", config: "", localSystem: "" };

  async function node(title: string, sourceType: "manual" | "system", tagId: string): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'content', $3, $4, $5) RETURNING id::text`,
      [workspaceId, sourceType, title, randomUUID(), `${title} mentions ${word}.`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    return id;
  }

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('SysScope',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    ids.tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'class_tag', 'Topic', $2, '') RETURNING id::text`, [workspaceId, `tag-${randomUUID()}`])).rows[0]!.id;
    ids.note = await node("Ordinary", "manual", ids.tag);
    ids.system = await node("Machinery", "system", ids.tag);
    // The workspace-config tag (by its key) carrying the topic tag.
    ids.config = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, reserved_key)
       VALUES ($1, 'manual', 'class_tag', 'workspace-config', $2, $3, 'workspace-config') RETURNING id::text`,
      [workspaceId, `tag-${randomUUID()}`, `Config mentions ${word}.`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [ids.config, ids.tag]);
    // A system note in a readable space whose external AI is off.
    ids.localSystem = await node("Local machinery", "system", ids.tag);
    await putInSpace(ids.localSystem, await makeSpace(workspaceId, `local-${randomUUID()}`,
      [{ id: actor.id, role: "manager" }], { publish: false, external_ai: false, backup: true }));
  });

  it("the fixture's system note is readable — only the system rule keeps it out", async () => {
    const r = await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND space_id IS NOT NULL`, [ids.system]);
    expect(r.rows).toHaveLength(1);
    const { readable, allowed } = await aiReadable(workspaceId, actor);
    expect(allowed.has(ids.note)).toBe(true);
    for (const id of [ids.system, ids.config, ids.localSystem]) {
      expect(readable.has(id)).toBe(false);
      expect(allowed.has(id)).toBe(false);
    }
  });

  it("tag scope gathers the ordinary note only", async () => {
    const gathered = await gatherTag(workspaceId, actor, { tagId: ids.tag });
    expect(gathered.sources.map((s) => s.id)).toEqual([ids.note]);
    expect(gathered.blocks.join("\n")).not.toContain("Machinery");
    // The local-only system note does not name its space as the reason.
    expect(gathered.blockedSpaceIds).toBeUndefined();
  });

  it("nodes scope leaves a system note out, and a scope of only system notes is unavailable", async () => {
    const gathered = await gatherNodes(workspaceId, actor, { ids: [ids.system, ids.config, ids.note] });
    expect(gathered.sources.map((s) => s.id)).toEqual([ids.note]);
    const refused = await gatherNodes(workspaceId, actor, { ids: [ids.system, ids.localSystem] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ScopeUnavailable);
    expect((refused as ScopeUnavailable).reason).toBeUndefined();
  });

  it("search scope and node search find the ordinary note, never the system ones", async () => {
    const gathered = await gatherSearch(workspaceId, actor, { query: word });
    const sent = gathered.sources.map((s) => s.id);
    expect(sent).toContain(ids.note);
    for (const id of [ids.system, ids.config, ids.localSystem]) expect(sent).not.toContain(id);
    expect(gathered.blockedSpaceIds).toBeUndefined();

    const found = (await searchNodes(workspaceId, word, actor, 50)).map((r) => r.id);
    expect(found).toEqual([ids.note]);
    const byTag = (await searchNodes(workspaceId, "#Topic", actor, 50)).map((r) => r.id);
    expect(byTag).toEqual([ids.note]);
  });
});
