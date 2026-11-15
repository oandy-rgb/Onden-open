// Agent createNode tool (capability + scope) against a real Postgres. The
// create-side counterpart to updateNode: a scoped agent can create notes, but
// only WITHIN its write spaces, attributed + atomic via the spine.
//
//   - a token reaches only its agent's spaces (membership; no per-token space
//     list), so it may only create where the agent has edit; naming another
//     space, or the agent having none, is refused;
//   - a valid create is attributed actor_type='ai_agent', the node is tagged
//     in-scope, and a NODE_CREATED event lands;
//   - dry-run writes nothing;
//   - an unrestricted actor may create untagged.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { createEdge } from "../services/edgeWrites.js";
import { createTagView, viewCreateSchema } from "../services/tagViews.js";
import { AuthorityError } from "../spine/authority.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules(); // the view layouts (table) are modules

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const human: ActorCtx = { id: "owner", name: "Owner", role: "admin", type: "human" }; // no tokenScope


describe.skipIf(!isTestDb)("agent createNode tool (DB)", () => {
  let WS = "", allowedTag = "", defaultSpace = "", otherSpace = "";
  const stamp = Date.now();
  // A write-access token whose agent is a member of exactly `editSpaceIds`
  // (persistActor joins the default space; that membership is replaced).
  const scoped = async (editSpaceIds: string[]) => {
    const agent = await persistActor(WS, {
      id: "agent", name: "Bot", type: "agent",
      tokenScope: { tokenId: "fixture", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    await q(`DELETE FROM space_members WHERE actor_id=$1`, [agent.id]);
    for (const spaceId of editSpaceIds) {
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'edit')`, [spaceId, agent.id]);
    }
    return agent;
  };
  const ctx = (actor: ActorCtx, dryRun = false) => ({ actor, workspaceId: WS, dryRun });
  const tagsOf = (nodeId: string) =>
    q<{ tag_id: string }>(`SELECT tag_id FROM node_tags WHERE node_id = $1`, [nodeId]);
  const createdEvent = (nodeId: string) =>
    q<{ actor_type: string }>(`SELECT actor_type FROM domain_events WHERE event_type='NODE_CREATED' AND target_id=$1`, [nodeId]);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(human, await persistActor(WS, human));
    const mkTag = async (name: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$3,'') RETURNING id`,
      [WS, name, `tag-${name}-${Date.now()}`],
    )).rows[0]!.id;
    // Tag titles are unique in a workspace; the shared DB keeps earlier runs'.
    allowedTag = await mkTag(`allowed ${stamp}`);
    defaultSpace = (await q<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id=$1 AND is_default`, [WS])).rows[0]!.id;
    otherSpace = await makeSpace(WS, `other-${Date.now()}`, [{ id: human.id, permission: "edit" }]);
  });

  it("a token creates only within the spaces its agent can edit", async () => {
    // agent in no space → refused
    await expect(callTool("createNode", { title: "Orphan" }, ctx(await scoped([])))).rejects.toBeInstanceOf(AuthorityError);
    // a space the agent is not a member of → refused
    await expect(callTool("createNode", { title: "Wrong", space_id: otherSpace }, ctx(await scoped([defaultSpace]))))
      .rejects.toBeInstanceOf(AuthorityError);
    // no space named → lands in its (only) editable space
    const res = await callTool("createNode", { title: "Placed" }, ctx(await scoped([defaultSpace]))) as { id: string };
    expect((await q<{ space_id: string }>(`SELECT space_id FROM content_nodes WHERE id=$1`, [res.id])).rows[0]!.space_id).toBe(defaultSpace);
  });

  it("a valid scoped create is tagged + attributed ai_agent", async () => {
    const res = await callTool("createNode", { title: "Note A", markdown: "# hi", tag_id: allowedTag }, ctx(await scoped([defaultSpace]))) as { id: string };
    expect(res.id).toBeTruthy();
    expect((await tagsOf(res.id)).rows.map((r) => r.tag_id)).toContain(allowedTag);
    expect((await createdEvent(res.id)).rows[0]?.actor_type).toBe("ai_agent");
  });

  it("tagging at create runs the full apply contract (field defaults)", async () => {
    const tagged = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
       VALUES ($1,'manual','class_tag',$4,$2,'',$3::jsonb) RETURNING id`,
      [WS, `tag-withdefault-${Date.now()}`, JSON.stringify({ fields: [{ name: "stage", type: "text", default: "draft" }] }), `withdefault ${stamp}`],
    )).rows[0]!.id;
    const res = await callTool("createNode", { title: "Defaulted", tag_id: tagged }, ctx(human)) as { id: string };
    const attr = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='stage'`, [res.id]);
    expect(attr.rows[0]?.value).toBe("draft");
  });

  it("dry-run writes nothing", async () => {
    // Scoped to this test's own agent and title: the workspace is shared.
    const agent = await scoped([defaultSpace]);
    const title = `Ghost ${stamp}`;
    const res = await callTool("createNode", { title, tag_id: allowedTag }, ctx(agent, true)) as { id: string };
    expect(res.id).toBe("(dry-run)");
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND title=$2`, [WS, title])).rows).toEqual([]);
    expect((await q(`SELECT 1 FROM domain_events WHERE actor_id::text=$1`, [agent.id])).rows).toEqual([]);
  });

  it("an unrestricted actor may create an untagged node", async () => {
    const res = await callTool("createNode", { title: "Free", markdown: "x" }, ctx(human)) as { id: string };
    expect(res.id).toBeTruthy();
    expect((await tagsOf(res.id)).rows.length).toBe(0);
  });

  // What is on the website is its owner's to decide: a token has no way to mark a note as published.
  it("a token may not set the publish mark on the note it creates, and nothing is created; a person may", async () => {
    const agent = await scoped([defaultSpace]);
    const title = `Published by a token ${stamp}`;
    await expect(callTool("createNode", { title, attributes: [{ key: "_published", value: "true" }] }, ctx(agent)))
      .rejects.toBeInstanceOf(AuthorityError);
    // 「不發布」 is the same mark: the token does not decide it either way.
    await expect(callTool("createNode", { title, attributes: [{ key: "_published", value: "false" }] }, ctx(agent)))
      .rejects.toBeInstanceOf(AuthorityError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND title=$2`, [WS, title])).rows).toEqual([]);
    // Another attribute of the same create is still fine for the token.
    const plain = await callTool("createNode", { title: `Plain by a token ${stamp}`, attributes: [{ key: "stage", value: "draft" }] }, ctx(agent)) as { id: string };
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='stage'`, [plain.id])).rows[0]?.value).toBe("draft");
    const res = await callTool("createNode", { title: `Published by a person ${stamp}`, attributes: [{ key: "_published", value: "true" }] }, ctx(human)) as { id: string };
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='_published'`, [res.id])).rows[0]?.value).toBe("true");
  });

  // queryView answers from the app's own view function (services/tagViews.ts executeTagView), not from a copy of its
  // query. A tag definition is global — every caller in the workspace sees a live tag (spine/spaceScope.ts) — so today
  // the two could not differ in who sees a view; they can no longer drift apart either. What stays hidden is a view
  // whose tag is in the trash, and it answers with the same words as a view that does not exist.
  it("queryView answers through the app's view function: a live tag's view with its settings, a trashed tag's view as not found", async () => {
    const tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$3,'') RETURNING id`, [WS, `viewed ${stamp}`, `tag-viewed-${stamp}`],
    )).rows[0]!.id;
    const view = (await createTagView(human, WS, tag, viewCreateSchema.parse({ name: `Pay ${stamp}`, layout: "table", visible_fields: ["salary"] })))!.id;
    const member = await scoped([defaultSpace]);
    expect(await callTool("queryView", { viewId: view }, ctx(member))).toMatchObject({ view: { id: view, tagId: tag, layout: "table", visibleFields: ["salary"] }, rows: [], count: 0 });

    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [tag]);
    const gone = await callTool("queryView", { viewId: view }, ctx(member)).then((r) => JSON.stringify(r), (e: Error) => e.message);
    expect(gone).toBe(`view not found: ${view}`);
    await expect(callTool("queryView", { viewId: "00000000-0000-4000-8000-000000000000" }, ctx(member))).rejects.toThrow("view not found: 00000000-0000-4000-8000-000000000000");
  });

  // The check lives in the service, so a caller that is not the REST route gets it too.
  it("createEdge refuses a target the caller cannot read (404, as if it did not exist), whoever calls the service", async () => {
    const agent = await scoped([defaultSpace]);
    const source = (await callTool("createNode", { title: `Edge source ${stamp}` }, ctx(agent)) as { id: string }).id;
    const hidden = (await callTool("createNode", { title: `Edge hidden ${stamp}`, space_id: otherSpace }, ctx(human)) as { id: string }).id;
    const open = (await callTool("createNode", { title: `Edge open ${stamp}`, space_id: defaultSpace }, ctx(human)) as { id: string }).id;
    const edge = (target: string) => ({ source_node_id: source, target_node_id: target, edge_type: "related", status: "active" as const });
    await expect(createEdge(agent, WS, edge(hidden))).rejects.toMatchObject({ status: 404 });
    expect((await q(`SELECT 1 FROM node_edges WHERE source_node_id=$1 AND target_node_id=$2`, [source, hidden])).rows).toEqual([]);
    expect((await createEdge(agent, WS, edge(open))).target_node_id).toBe(open);
  });
});
