// B (MCP agent) live HTTP smoke — exercises Day 1-4 substrate end-to-end.
//
// Coverage:
//   1. Token minting with full scope params (tools + tags + expires)
//   2. mint validation rejects unknown tools + invalid tag UUIDs
//   3. GET /api/mcp/tools lists registered tools
//   4. POST /api/mcp/tools/searchNodes succeeds with scoped token
//   5. POST /api/mcp/tools/getNode succeeds
//   6. POST /api/mcp/tools/updateNode succeeds on in-scope node
//   7. POST /api/mcp/tools/updateNode 403 tag_not_allowed on out-of-scope node
//   8. POST /api/mcp/tools/applyTag 403 tag_not_allowed for non-allowlisted tag
//   9. POST /api/mcp/tools/applyTag succeeds for allowlisted tag
//  10. POST /api/mcp/tools/removeTag succeeds
//  11. Bad bearer → 401
//  12. Soft-revoke via POST /:tokenId/revoke
//  13. Revoked token → 401 on next call
//  14. domain_events trail has AGENT_TOOL_CALLED rows with right tx_meta
//
// Run: NODE_ENV=test DATABASE_URL=... npx tsx scripts/bMcpSmoke.ts
//
// NODE_ENV=test gates serve() in index.ts so importing app doesn't bind a port.

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { pool } from "../src/db.js";

let pass = 0, fail = 0;
function step(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
}
function section(name: string) { console.log(`\n— ${name} —`); }

type JsonObj = Record<string, unknown>;

async function mcp(toolName: string, args: JsonObj, bearer: string): Promise<{ status: number; body: JsonObj }> {
  const res = await app.request(`/api/mcp/tools/${toolName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ args }),
  });
  const body = await res.json() as JsonObj;
  return { status: res.status, body };
}

async function main() {
  // Use the default workspace because the route layer's getWorkspaceId()
  // resolves slug='default'. We tag our own rows with a unique smoke
  // suffix in slugs / actor names for clean teardown.
  const wsRes = await pool.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1`,
  );
  const workspaceId = wsRes.rows[0]?.id;
  if (!workspaceId) throw new Error("default workspace missing; can't run smoke");

  const smokeTag = `smk-${randomUUID().slice(0, 8)}`;
  const actorId = randomUUID();
  const allowedTagId = randomUUID();
  const otherTagId = randomUUID();
  const inScopeNodeId = randomUUID();
  const outOfScopeNodeId = randomUUID();
  const allowedViewId = randomUUID();
  const oosViewId = randomUUID();

  console.log(`B MCP smoke`);
  console.log(`  workspace (default): ${workspaceId.slice(0, 8)}…`);
  console.log(`  smoke tag: ${smokeTag}`);

  let tokenPlaintext = "";
  let tokenId = "";
  let freshNodeId = "";

  try {
    // ── Setup ───────────────────────────────────────────────────────────────
    // Agent actor — token will bind to this
    await pool.query(
      `INSERT INTO actors (id, workspace_id, name, type, role)
       VALUES ($1, $2, $3, 'agent', 'editor')`,
      [actorId, workspaceId, `${smokeTag}-agent`],
    );
    // Two class_tag nodes — one allowed for the token, one not
    await pool.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '')`,
      [allowedTagId, workspaceId, `${smokeTag}-allow`, `tag-${smokeTag}-allow`],
    );
    await pool.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '')`,
      [otherTagId, workspaceId, `${smokeTag}-other`, `tag-${smokeTag}-other`],
    );
    // Two content nodes — one tagged with allowed-tag (in scope), one with other-tag (out of scope)
    await pool.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '# Original')`,
      [inScopeNodeId, workspaceId, `${smokeTag}-in`, `${smokeTag}-in`],
    );
    await pool.query(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [inScopeNodeId, allowedTagId]);
    await pool.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '# Other')`,
      [outOfScopeNodeId, workspaceId, `${smokeTag}-oos`, `${smokeTag}-oos`],
    );
    await pool.query(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [outOfScopeNodeId, otherTagId]);

    // Two saved CollectionViews — one per tag — for queryView smoke
    await pool.query(
      `INSERT INTO collection_views (id, workspace_id, tag_id, name, layout)
       VALUES ($1, $2, $3, $4, 'table')`,
      [allowedViewId, workspaceId, allowedTagId, `${smokeTag}-view-in`],
    );
    await pool.query(
      `INSERT INTO collection_views (id, workspace_id, tag_id, name, layout)
       VALUES ($1, $2, $3, $4, 'table')`,
      [oosViewId, workspaceId, otherTagId, `${smokeTag}-view-oos`],
    );

    // ── 1. mint validation rejects unknown tools ───────────────────────────
    section("1. mint validation");
    // Need an admin context. We'll INSERT the token directly into agent_tokens
    // via the service (bypassing the HTTP mint), since the mint route requires
    // a session/native admin. For validation tests we hit the route via
    // native-origin bypass which gives us 'system' admin actor.
    const badToolsRes = await app.request(`/api/actors/${actorId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ name: "bad", allowed_tools: ["searchNodes", "notARealTool"] }),
    });
    step("unknown tool rejected (400)", badToolsRes.status === 400);
    const badToolsBody = await badToolsRes.json() as JsonObj;
    step("error body cites unknown tool",
      (badToolsBody as JsonObj).error === "unknown_tools" &&
      Array.isArray((badToolsBody.detail as JsonObj)?.unknown) &&
      ((badToolsBody.detail as JsonObj).unknown as string[]).includes("notARealTool"),
    );

    const badTagsRes = await app.request(`/api/actors/${actorId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ name: "bad", allowed_tag_ids: [allowedTagId, randomUUID()] }),
    });
    step("invalid tag id rejected (400)", badTagsRes.status === 400);

    // ── 2. mint the real scoped token ──────────────────────────────────────
    section("2. mint scoped token");
    const mintRes = await app.request(`/api/actors/${actorId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        name: "smoke-token",
        allowed_tools: ["searchNodes", "getNode", "createNode", "updateNode", "applyTag", "removeTag", "queryView"],
        allowed_tag_ids: [allowedTagId],
      }),
    });
    step("mint returns 201", mintRes.status === 201);
    const mintBody = await mintRes.json() as JsonObj & { id: string; token: string };
    tokenPlaintext = mintBody.token;
    tokenId = mintBody.id;
    step("plaintext starts with ondt_", tokenPlaintext.startsWith("ondt_"));

    // ── 3. GET tools list ──────────────────────────────────────────────────
    section("3. tools listing");
    const listRes = await app.request(`/api/mcp/tools`, {
      headers: { Authorization: `Bearer ${tokenPlaintext}` },
    });
    step("GET /api/mcp/tools is 200", listRes.status === 200);
    const listBody = await listRes.json() as { tools: Array<{ name: string }> };
    const names = listBody.tools.map((t) => t.name).sort();
    // The 6 core tools must always be present; the registry may expose MORE
    // (semanticSearch, suggestLinks, …) so assert containment, not exact count.
    const CORE_TOOLS = ["applyTag", "getNode", "queryView", "removeTag", "searchNodes", "updateNode"];
    step(`registry exposes the ${CORE_TOOLS.length} core tools (has ${names.length})`,
      CORE_TOOLS.every((t) => names.includes(t)),
    );

    // ── 4. searchNodes — read tool, NOW tag-scoped (audit #1) ──────────────
    section("4. searchNodes (read, tag-scoped)");
    const search = await mcp("searchNodes", { query: smokeTag }, tokenPlaintext);
    step("searchNodes is 200", search.status === 200, JSON.stringify(search.body).slice(0, 80));
    const searchIds = ((search.body as { result?: Array<{ id: string }> }).result ?? []).map((r) => r.id);
    step("searchNodes excludes out-of-scope nodes", !searchIds.includes(outOfScopeNodeId));

    // ── 5. getNode — in-scope succeeds, out-of-scope resolves to null ──────
    section("5. getNode (tag-scoped)");
    const getRes = await mcp("getNode", { id: inScopeNodeId }, tokenPlaintext);
    step("getNode is 200", getRes.status === 200);
    const result = (getRes.body as { result: { id: string; tags: Array<{id:string}> } }).result;
    step("getNode returns the right node", result?.id === inScopeNodeId);
    step("getNode includes tags", result?.tags?.some((t) => t.id === allowedTagId));
    const getOos = await mcp("getNode", { id: outOfScopeNodeId }, tokenPlaintext);
    step("getNode out-of-scope returns null (no existence oracle)",
      getOos.status === 200 && (getOos.body as { result: unknown }).result === null);

    // ── 5b. createNode — scoped create ─────────────────────────────────────
    section("5b. createNode (tag-scoped)");
    const createOrphan = await mcp("createNode", { title: "agent-orphan" }, tokenPlaintext);
    step("createNode without a tag is 403 (scope requires anchoring)", createOrphan.status === 403);
    step("error code = tag_not_allowed", createOrphan.body.error === "tag_not_allowed");
    const createOk = await mcp("createNode", { title: "agent-made", markdown: "# by agent", tag_id: allowedTagId }, tokenPlaintext);
    step("createNode with allowed tag is 201/200", createOk.status === 200 || createOk.status === 201,
      JSON.stringify(createOk.body).slice(0, 90));
    const createdId = (createOk.body as { result?: { id: string } }).result?.id ?? "";
    const createdRow = await pool.query(`SELECT 1 FROM content_nodes WHERE id = $1`, [createdId]);
    step("created node exists in DB", (createdRow.rowCount ?? 0) === 1);
    const createdTag = await pool.query(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [createdId, allowedTagId]);
    step("created node is tagged in-scope", (createdTag.rowCount ?? 0) === 1);

    // ── 5c. token confined to the MCP surface ─────────────────────────────
    section("5c. token confined to MCP (capability == granted tools)");
    const confinedBoot = await app.request(`/api/bootstrap`, { headers: { Authorization: `Bearer ${tokenPlaintext}` } });
    step("agent bearer on /api/bootstrap is 403 (not a general API key)", confinedBoot.status === 403);
    const confinedActors = await app.request(`/api/actors`, {
      method: "POST", body: "{}", headers: { Authorization: `Bearer ${tokenPlaintext}`, "Content-Type": "application/json" },
    });
    step("agent bearer on /api/actors is 403 (can't reach permission routes)", confinedActors.status === 403);
    const stillWorks = await mcp("getNode", { id: inScopeNodeId }, tokenPlaintext);
    step("same token still works on /api/mcp (getNode 200)", stillWorks.status === 200);

    // ── 6. updateNode succeeds on in-scope node ────────────────────────────
    section("6. updateNode (in scope)");
    const updRes = await mcp("updateNode", {
      id: inScopeNodeId,
      markdown: "# Updated by agent",
      base_markdown: (stillWorks.body as { result: { markdown: string } }).result.markdown,
    }, tokenPlaintext);
    step("updateNode in-scope is 200", updRes.status === 200, JSON.stringify(updRes.body).slice(0, 100));
    const verifyUpd = await pool.query<{ markdown: string }>(
      `SELECT markdown FROM content_nodes WHERE id = $1`,
      [inScopeNodeId],
    );
    step("DB markdown actually changed", verifyUpd.rows[0]?.markdown === "# Updated by agent");

    // ── 7. updateNode 403 on out-of-scope node ─────────────────────────────
    section("7. updateNode (out of scope)");
    const updOos = await mcp("updateNode", {
      id: outOfScopeNodeId,
      markdown: "# Should fail",
      base_markdown: "",
    }, tokenPlaintext);
    step("updateNode out-of-scope is 403", updOos.status === 403);
    step("error code = tag_not_allowed", updOos.body.error === "tag_not_allowed");

    // ── 8. applyTag with non-allowlisted tag → 403 ─────────────────────────
    section("8. applyTag (tag not in scope)");
    const applyOos = await mcp("applyTag", {
      nodeId: inScopeNodeId,
      tagId: otherTagId,
    }, tokenPlaintext);
    step("applyTag non-allowlisted is 403", applyOos.status === 403);
    step("error code = tag_not_allowed", applyOos.body.error === "tag_not_allowed");

    // ── 9. applyTag with allowlisted tag to a fresh untagged node ──────────
    section("9. applyTag (allowed tag, untagged target = claimable)");
    freshNodeId = randomUUID();
    await pool.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '')`,
      [freshNodeId, workspaceId, `${smokeTag}-fresh`, `${smokeTag}-fresh`],
    );
    const applyOk = await mcp("applyTag", {
      nodeId: freshNodeId,
      tagId: allowedTagId,
    }, tokenPlaintext);
    step("applyTag claimable is 200", applyOk.status === 200, JSON.stringify(applyOk.body).slice(0, 100));
    const verifyTag = await pool.query(
      `SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`,
      [freshNodeId, allowedTagId],
    );
    step("DB row inserted", verifyTag.rowCount === 1);

    // ── 10. removeTag succeeds ─────────────────────────────────────────────
    section("10. removeTag");
    const rmRes = await mcp("removeTag", {
      nodeId: freshNodeId,
      tagId: allowedTagId,
    }, tokenPlaintext);
    step("removeTag is 200", rmRes.status === 200);
    const verifyGone = await pool.query(
      `SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`,
      [freshNodeId, allowedTagId],
    );
    step("DB row removed", verifyGone.rowCount === 0);

    // ── 10b. queryView in-scope ─────────────────────────────────────────────
    section("10b. queryView (allowed view tag)");
    const qvIn = await mcp("queryView", { viewId: allowedViewId }, tokenPlaintext);
    step("queryView in-scope is 200", qvIn.status === 200, JSON.stringify(qvIn.body).slice(0, 80));
    const qvBody = (qvIn.body as { result: { view: { tagId: string }; rows: unknown[] } }).result;
    step("returns view config + rows", qvBody?.view?.tagId === allowedTagId && Array.isArray(qvBody?.rows));

    // ── 10c. queryView out-of-scope ─────────────────────────────────────────
    section("10c. queryView (view tag not in scope)");
    const qvOos = await mcp("queryView", { viewId: oosViewId }, tokenPlaintext);
    step("queryView out-of-scope is 403", qvOos.status === 403);
    step("error code = tag_not_allowed", qvOos.body.error === "tag_not_allowed");

    // ── 10d. dry-run mode ───────────────────────────────────────────────────
    section("10d. dry-run mode (write tools simulate)");
    // Re-tag in-scope node first since #6 changed it but #9-10 used a different node
    const dryUpdRes = await app.request(`/api/mcp/tools/updateNode?dryRun=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenPlaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ args: { id: inScopeNodeId, markdown: "# WOULD CHANGE" } }),
    });
    step("dry-run updateNode is 200", dryUpdRes.status === 200);
    const dryUpdBody = await dryUpdRes.json() as { ok: boolean; result: { event_id: string }; dryRun: boolean };
    step("response envelope carries dryRun:true", dryUpdBody.dryRun === true);
    step("result preview marks event_id=(dry-run)", dryUpdBody.result?.event_id === "(dry-run)");
    const verifyUnchanged = await pool.query<{ markdown: string }>(
      `SELECT markdown FROM content_nodes WHERE id = $1`,
      [inScopeNodeId],
    );
    step("DB markdown UNCHANGED after dry-run", verifyUnchanged.rows[0]?.markdown === "# Updated by agent");

    // dry-run applyTag on out-of-scope tag should STILL fail (scope check runs)
    const dryApplyOosRes = await app.request(`/api/mcp/tools/applyTag?dryRun=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenPlaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ args: { nodeId: inScopeNodeId, tagId: otherTagId } }),
    });
    step("dry-run applyTag scope rejected (403)", dryApplyOosRes.status === 403);

    // ── 10e. MCP-protocol surface (JSON-RPC over streamable HTTP) ──────────
    section("10e. MCP-protocol JSON-RPC");
    async function mcpRpc(body: JsonObj): Promise<{ status: number; body: JsonObj | string }> {
      const res = await app.request(`/api/mcp/protocol`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPlaintext}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as JsonObj };
      } catch {
        return { status: res.status, body: text };
      }
    }

    // The streamable-HTTP transport returns SSE-framed JSON-RPC by default
    // (`event: message\ndata: {…}\n\n`). Extract the data payload before parsing.
    function unwrapSseJson<T = unknown>(body: JsonObj | string): T | null {
      if (typeof body === "object") return body as T;
      const m = /^data:\s*(.*)$/m.exec(body);
      if (!m) return null;
      try { return JSON.parse(m[1]) as T; } catch { return null; }
    }

    const initRes = await mcpRpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bMcpSmoke", version: "0.1.0" },
      },
    });
    step(`initialize is 200 (got ${initRes.status})`, initRes.status === 200);
    type RpcRes = { result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }>; content?: Array<{ type: string; text?: string }> } };
    const initBody = unwrapSseJson<RpcRes>(initRes.body);
    step("initialize result has serverInfo.name=onden",
      initBody?.result?.serverInfo?.name === "onden",
      JSON.stringify(initRes.body).slice(0, 80));

    const rpcListRes = await mcpRpc({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    step(`tools/list is 200 (got ${rpcListRes.status})`, rpcListRes.status === 200);
    const rpcListBody = unwrapSseJson<RpcRes>(rpcListRes.body);
    const listResultTools = rpcListBody?.result?.tools ?? [];
    step("tools/list exposes the core tools (>=6)",
      listResultTools.length >= 6 && listResultTools.some((t) => t.name === "searchNodes"),
      `got ${listResultTools.length}`);

    const callRes = await mcpRpc({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "searchNodes", arguments: { query: "smoke" } },
    });
    step(`tools/call is 200 (got ${callRes.status})`, callRes.status === 200);
    const callBody = unwrapSseJson<RpcRes>(callRes.body);
    const callContent = callBody?.result?.content ?? [];
    step("tools/call returns content array",
      callContent.length > 0 && callContent[0]?.type === "text",
      callContent[0]?.text?.slice(0, 60));

    // ── 11. Bad bearer → 401 ───────────────────────────────────────────────
    section("11. bad bearer");
    const bad = await mcp("searchNodes", { query: "anything" }, "ondt_bogus");
    step("bad bearer is 401", bad.status === 401);

    // ── 12. Soft-revoke ────────────────────────────────────────────────────
    section("12. revoke");
    const revRes = await app.request(`/api/actors/${actorId}/tokens/${tokenId}/revoke`, {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    step("revoke endpoint is 200", revRes.status === 200);
    const revBody = await revRes.json() as { ok: boolean; revoked: boolean };
    step("revoke flipped revoked=true", revBody.revoked === true);

    // ── 13. Revoked token → 401 ────────────────────────────────────────────
    section("13. revoked token rejected");
    const afterRev = await mcp("searchNodes", { query: "anything" }, tokenPlaintext);
    step("revoked bearer is 401", afterRev.status === 401);

    // ── 14. Audit trail ────────────────────────────────────────────────────
    section("14. audit trail in domain_events");
    const auditRes = await pool.query<{
      event_type: string; actor_id: string; actor_type: string;
      tx_meta: { tool_name?: string; token_id?: string };
    }>(
      `SELECT event_type, actor_id, actor_type, tx_meta
       FROM domain_events
       WHERE workspace_id = $1 AND actor_type = 'ai_agent'
       ORDER BY created_at ASC`,
      [workspaceId],
    );
    step("≥1 AGENT_TOOL_CALLED row", auditRes.rows.some((r) => r.event_type === "AGENT_TOOL_CALLED"));
    step("tool_name + token_id in tx_meta",
      auditRes.rows.some((r) => r.tx_meta?.tool_name && r.tx_meta?.token_id === tokenId),
    );
    step("≥1 AGENT_TOOL_FAILED row (from rejections)",
      auditRes.rows.some((r) => r.event_type === "AGENT_TOOL_FAILED"),
    );

  } finally {
    // Surgical cleanup — we share the default workspace, only remove our rows.
    // FK chain: deleting content_nodes cascades node_tags + node_attributes;
    // deleting actors cascades agent_tokens.
    const ourNodes = [allowedTagId, otherTagId, inScopeNodeId, outOfScopeNodeId];
    if (freshNodeId) ourNodes.push(freshNodeId);
    await pool.query(
      `DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`,
      [ourNodes],
    );
    await pool.query(`DELETE FROM actors WHERE id = $1`, [actorId]);
    // Audit rows: keep AGENT_TOOL_CALLED for forensics — they reference the
    // (now-deleted) actor via actor_id text, so no FK violation. Prune events
    // older than retention happens via /api/maintenance/prune in normal ops.
    await pool.end();
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error("smoke failed:", err); process.exit(1); });
