// W35: tokens and agent tools converge on the shared operations, against a
// real Postgres.
//   (a) removing a member revokes the tokens they issued (401), and a token
//       whose issuer disappears by any other path keeps only what its agent's
//       own space membership gives it (no issuer clamp since migration 127);
//   (b) restoring a saved version is an ordinary edit: a tag's old name can't
//       duplicate a sibling, the slug is recomputed, and a caller who may not
//       edit the note can't probe which version ids exist;
//   (c) createNode with tag_ids + attributes makes the same note as REST POST;
//   (d) a token's tools/list (MCP and GET /api/mcp/tools) shows only its tools,
//       and the tool rate limit is the agent's, shared by its tokens.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import actorsRouter from "../routes/actors.js";
import nodesRouter from "../routes/nodes.js";
import mcpRouter from "../routes/mcp.js";
import mcpProtocolRouter from "../routes/mcpProtocol.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { callTool } from "../services/agentTools/index.js";
import { getRateLimiter, setRateLimiter } from "../services/agentTools/rateLimit.js";
import { updateNode, restoreNodeVersion, NodeUpdateError } from "../services/nodeUpdate.js";
import { TagNameConflictError } from "../services/tagHierarchy.js";
import { UnauthorizedError } from "../spine/actor.js";
import { AuthorityError } from "../spine/authority.js";
import { spaceAccess } from "../spine/spaceAccess.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { nativeOwnerActor, persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/actors", actorsRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/mcp", mcpRouter);
app.route("/api/mcp/protocol", mcpProtocolRouter);

const json = (method: string, body: unknown) =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const stamp = () => Math.random().toString(36).slice(2, 8);

describe.skipIf(!isTestDb)("W35 token and agent tool convergence (DB)", () => {
  let WS = "";
  let owner: ActorCtx;
  let space = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await nativeOwnerActor(WS);
    // Pin the owner: on a workspace with none, the first human persisted below
    // (an issuer these tests remove) would become it, and an owner can't be removed.
    await setWorkspaceOwner(WS, owner.id);
    space = await makeSpace(WS, `w35-${stamp()}`, [{ id: owner.id, permission: "edit" }]);
  });

  /** A member who issues a token to a fresh agent; both are in `space`. */
  async function issuedToken() {
    const issuer = await persistActor(WS, { id: "", name: `Issuer ${stamp()}`, role: "editor", type: "human" });
    const agent = await persistActor(WS, { id: "", name: `Agent ${stamp()}`, role: "editor", type: "agent" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit'), ($1, $3, 'edit')`,
      [space, issuer.id, agent.id]);
    const token = await createToken(agent.id, { issuedBy: issuer.id });
    return { issuer, agent, token };
  }

  describe("(a) a removed member's tokens", () => {
    it("are revoked with them: the bearer is refused (401)", async () => {
      const { issuer, token } = await issuedToken();
      const before = await resolveBearerActor(token.plaintext, WS);
      expect(before?.tokenScope?.issuedBy).toBe(issuer.id);
      expect((await spaceAccess(before!, space))?.read).toBe(true);

      currentActor = owner;
      expect((await app.request(`/api/actors/${issuer.id}`, { method: "DELETE" })).status).toBe(200);

      expect(await resolveBearerActor(token.plaintext, WS)).toBeNull(); // auth middleware → 401
      await expect(resolveCurrentActor({ id: before!.id, tokenScope: { tokenId: token.id } }, WS))
        .rejects.toBeInstanceOf(UnauthorizedError);
      const row = (await q<{ revoked: boolean; marked: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked, issuer_removed_at IS NOT NULL AS marked FROM agent_tokens WHERE id = $1`,
        [token.id])).rows[0]!;
      expect(row).toEqual({ revoked: true, marked: true });
    });

    it("keep only the agent's own reach (no issuer clamp) when the issuer row is deleted another way", async () => {
      const { issuer, agent, token } = await issuedToken();
      await q(`DELETE FROM actors WHERE id = $1`, [issuer.id]);
      const after = await resolveCurrentActor({ id: agent.id, tokenScope: { tokenId: token.id } }, WS);
      expect(after.tokenScope?.issuedBy ?? null).toBeNull();
      // Reach is the agent's membership of `space`, read-only for this token.
      expect(await spaceAccess(after, space)).toMatchObject({ read: true, write: false });
      // The agent loses the space → the token reaches nothing there.
      await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [space, agent.id]);
      expect((await spaceAccess(after, space))?.read).toBe(false);
    });

    it("leave a token 098 never attributed (NULL issuer, never removed) on its agent's own reach", async () => {
      const agent = await persistActor(WS, { id: "", name: `Legacy ${stamp()}`, role: "editor", type: "agent" });
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [space, agent.id]);
      const token = await createToken(agent.id, { access: "read" });
      const actor = await resolveCurrentActor({ id: agent.id, tokenScope: { tokenId: token.id } }, WS);
      expect(actor.tokenScope?.issuedBy ?? null).toBeNull();
      expect((await spaceAccess(actor, space))?.read).toBe(true);
    });
  });

  describe("(b) restoring a version", () => {
    const tag = async (title: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id`, [WS, title, `w35-${stamp()}`])).rows[0]!.id;
    const row = async (id: string) => (await q<{ title: string; slug: string; markdown: string }>(
      `SELECT title, slug, markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!;

    it("of a tag can't take a sibling's name, and recomputes the slug when it can", async () => {
      const old = `Alpha ${stamp()}`;
      const id = await tag(old);
      const v1 = (await updateNode(WS, id, { title: old, markdown: "first" }, { actor: owner })).eventId!;
      await updateNode(WS, id, { title: `Beta ${stamp()}`, markdown: "second" }, { actor: owner });

      const sibling = await tag(old);
      await expect(restoreNodeVersion(WS, id, v1, { actor: owner })).rejects.toBeInstanceOf(TagNameConflictError);
      currentActor = owner;
      expect((await app.request(`/api/nodes/${id}/versions/${v1}/restore`, { method: "POST" })).status).toBe(409);
      expect((await row(id)).markdown).toBe("second");

      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [sibling]);
      const { node } = await restoreNodeVersion(WS, id, v1, { actor: owner });
      expect(node).toMatchObject({ title: old, markdown: "first" });
      // The title comes back as a tag rename (T11): the tag- slug, not a note slug.
      expect((await row(id)).slug).toBe(`tag-${old.toLowerCase().replace(/\s+/g, "-")}`);
      const restored = (await q<{ payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
        `SELECT payload, tx_meta FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_RESTORED'
          ORDER BY id DESC LIMIT 1`, [id])).rows[0]!;
      expect(restored.payload).toMatchObject({ version_id: v1, title: old });
      expect(typeof restored.payload.body_hash).toBe("string");
      expect(restored.tx_meta).toMatchObject({ ui_context: "node.version.restore" });
      expect(typeof restored.tx_meta.inverse_patch).toBe("string");
    });

    it("answers the same to a non-editor whether or not the version exists", async () => {
      const id = (await callTool("createNode", { title: `Private ${stamp()}`, space_id: space }, { actor: owner, workspaceId: WS }) as { id: string }).id;
      const v1 = (await updateNode(WS, id, { markdown: "one" }, { actor: owner })).eventId!;
      const outsider = await persistActor(WS, { id: "", name: `Out ${stamp()}`, role: "editor", type: "human" });
      await expect(restoreNodeVersion(WS, id, v1, { actor: outsider })).rejects.toBeInstanceOf(AuthorityError);
      await expect(restoreNodeVersion(WS, id, "999999999999", { actor: outsider })).rejects.toBeInstanceOf(AuthorityError);
      await expect(restoreNodeVersion(WS, id, "999999999999", { actor: owner })).rejects.toBeInstanceOf(NodeUpdateError);
    });

    it("refuses a trashed note", async () => {
      const id = (await callTool("createNode", { title: `Trashed ${stamp()}`, space_id: space }, { actor: owner, workspaceId: WS }) as { id: string }).id;
      const v1 = (await updateNode(WS, id, { markdown: "one" }, { actor: owner })).eventId!;
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id]);
      await expect(restoreNodeVersion(WS, id, v1, { actor: owner })).rejects.toMatchObject({ status: 404, message: "node not found" });
    });
  });

  describe("(c) createNode tool and REST POST", () => {
    it("make the same note from tag_ids + attributes", async () => {
      const tagId = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1, 'manual', 'class_tag', $2, $3, '', $4::jsonb) RETURNING id`,
        [WS, `Stage ${stamp()}`, `w35-stage-${stamp()}`,
          JSON.stringify({ fields: [{ name: "stage", type: "text", default: "draft" }] })])).rows[0]!.id;
      const body = {
        markdown: "body [[nowhere]]", space_id: space, tag_ids: [tagId],
        attributes: [{ key: "priority", value: 2, value_type: "number" }, { key: "owner", value: "me" }],
      };
      currentActor = owner;
      const rest = await app.request("/api/nodes", json("POST", { title: `Rest ${stamp()}`, ...body }));
      expect(rest.status).toBe(201);
      const restId = (await rest.json() as { id: string }).id;
      const toolId = (await callTool("createNode", { title: `Tool ${stamp()}`, ...body }, { actor: owner, workspaceId: WS }) as { id: string }).id;

      const shape = async (id: string) => ({
        node: (await q(`SELECT markdown, space_id, node_type, source_type, parent_id, hidden FROM content_nodes WHERE id = $1`, [id])).rows[0],
        tags: (await q(`SELECT tag_id FROM node_tags WHERE node_id = $1 ORDER BY tag_id`, [id])).rows,
        attributes: (await q(`SELECT key, value, value_type, is_inheritable FROM node_attributes WHERE node_id = $1 ORDER BY key`, [id])).rows,
        events: (await q<{ event_type: string }>(`SELECT event_type FROM domain_events WHERE target_id = $1 ORDER BY id`, [id]))
          .rows.map((r) => r.event_type),
      });
      const [fromRest, fromTool] = [await shape(restId), await shape(toolId)];
      expect(fromTool).toEqual(fromRest);
      expect(fromRest.attributes.map((a) => (a as { key: string }).key)).toEqual(["owner", "priority", "stage"]);
    });

    it("still accepts the legacy tag_id, and shares the REST size caps", async () => {
      const tagId = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id`, [WS, `Legacy ${stamp()}`, `w35-l-${stamp()}`])).rows[0]!.id;
      const id = (await callTool("createNode", { title: `One tag ${stamp()}`, tag_id: tagId, space_id: space }, { actor: owner, workspaceId: WS }) as { id: string }).id;
      expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [id, tagId])).rows).toHaveLength(1);
      await expect(callTool("createNode", { title: "x".repeat(501), space_id: space }, { actor: owner, workspaceId: WS })).rejects.toThrow();
      currentActor = owner;
      expect((await app.request("/api/nodes", json("POST", { title: "x".repeat(501) }))).status).toBe(400);
    });

    it("dry-run updateNode previews through the shared edit without writing", async () => {
      const id = (await callTool("createNode", { title: `Preview ${stamp()}`, space_id: space }, { actor: owner, workspaceId: WS }) as { id: string }).id;
      const preview = await callTool("updateNode", { id, title: "Previewed Title" }, { actor: owner, workspaceId: WS, dryRun: true }) as { slug: string; event_id: string };
      expect(preview).toMatchObject({ slug: "previewed-title", event_id: "(dry-run)" });
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).not.toBe("Previewed Title");
    });
  });

  describe("(d) a token's tool surface", () => {
    async function scopedBearer(allowedTools: string[] | null) {
      const agent = await persistActor(WS, { id: "", name: `Tools ${stamp()}`, role: "editor", type: "agent" });
      const token = await createToken(agent.id, { allowedTools, issuedBy: owner.id });
      return { agent, token, actor: (await resolveBearerActor(token.plaintext, WS))! };
    }
    const rpc = async (actor: ActorCtx, body: unknown) => {
      currentActor = actor;
      const res = await app.request("/api/mcp/protocol", {
        method: "POST", body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      });
      const text = await res.text();
      const data = /^data:\s*(.*)$/m.exec(text)?.[1] ?? text;
      return JSON.parse(data) as { result?: { tools?: Array<{ name: string }> } };
    };

    it("lists only the allowed tools, over MCP and REST", async () => {
      const { actor } = await scopedBearer(["searchNodes", "getNode"]);
      await rpc(actor, { jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "w35", version: "0" } } });
      const listed = await rpc(actor, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(listed.result?.tools?.map((t) => t.name).sort()).toEqual(["getNode", "searchNodes"]);

      currentActor = actor;
      const rest = await (await app.request("/api/mcp/tools")).json() as { tools: Array<{ name: string }> };
      expect(rest.tools.map((t) => t.name).sort()).toEqual(["getNode", "searchNodes"]);

      const open = (await scopedBearer(null)).actor;
      expect((await rpc(open, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })).result?.tools?.length)
        .toBeGreaterThan(2);
    });

    it("meters tool calls per agent, not per token", async () => {
      const previous = getRateLimiter();
      const keys: string[] = [];
      setRateLimiter({ check: async (key) => { keys.push(key); }, reset: async () => {} });
      try {
        const { agent, actor } = await scopedBearer(null);
        const second = await createToken(agent.id, { issuedBy: owner.id });
        const other = (await resolveBearerActor(second.plaintext, WS))!;
        await callTool("searchNodes", { query: "w35" }, { actor, workspaceId: WS });
        await callTool("searchNodes", { query: "w35" }, { actor: other, workspaceId: WS });
        expect(keys).toEqual([`tools:${agent.id}`, `tools:${agent.id}`]);
      } finally {
        setRateLimiter(previous);
      }
    });
  });
});
