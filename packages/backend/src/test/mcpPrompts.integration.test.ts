// MCP prompts (prompts/list, prompts/get) go through the same gate as tools:
// the token's grant, the agent's rate budget, and an audit event. A locked-down
// token (allowed_tools = []) must not read note text through a prompt.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { _resetAuditOnce } from "../services/agentTools/auditOnce.js";
import { _resetRateLimits } from "../services/agentTools/rateLimit.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

afterAll(async () => { await pool.end(); });
beforeEach(async () => { await _resetRateLimits(); _resetAuditOnce(); });

async function rpc(token: string, method: string, params: unknown = {}): Promise<Record<string, any>> {
  const res = await app.request("/api/mcp/protocol", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}"
    : text;
  return JSON.parse(payload);
}

const outline = (nodeId: string) => ({ name: "outline", arguments: { node_ids: nodeId } });
const auditRows = async (agentId: string, namePrefix: string) =>
  (await q<{ event_type: string }>(
    `SELECT event_type FROM domain_events WHERE actor_id = $1 AND target_type = 'tool' AND target_id LIKE $2 ORDER BY id`, [agentId, `${namePrefix}%`])).rows.map((r) => r.event_type);

describe.skipIf(!isTestDb)("MCP prompts share the tools' gate", () => {
  it("a token with no allowed tools lists no prompts and gets no note text", async () => {
    const w = await agentWorld("promptlock");
    const secret = `祕密內文-${w.stamp}`;
    const nodeId = await w.note(secret);
    const locked = (await createToken(w.agent.id, { name: "locked", access: "read", allowedTools: [], issuedBy: w.owner.id })).plaintext;

    const listed = await rpc(locked, "prompts/list");
    expect(listed.error?.code ?? null).not.toBeNull(); // refused, not an empty-success that hides the attempt
    const got = await rpc(locked, "prompts/get", outline(nodeId));
    expect(JSON.stringify(got)).not.toContain(secret);
    expect(got.error).toBeTruthy();

    const audited = await auditRows(w.agent.id, "prompt:");
    expect(audited.length).toBe(1); // the list and the get are the same refusal inside one minute
    expect(audited.every((t) => t === "AGENT_TOOL_FAILED")).toBe(true);
  });

  it("an allowed token reads a prompt, and the get is audited", async () => {
    const w = await agentWorld("promptok");
    const marker = `可讀內文-${w.stamp}`;
    const nodeId = await w.note(marker);
    const token = (await createToken(w.agent.id, { name: "reader", access: "read", issuedBy: w.owner.id })).plaintext;

    const listed = await rpc(token, "prompts/list");
    expect(listed.result.prompts.map((p: { name: string }) => p.name)).toContain("outline");
    const got = await rpc(token, "prompts/get", outline(nodeId));
    expect(JSON.stringify(got.result)).toContain(marker);
    expect(await auditRows(w.agent.id, "prompt:outline")).toContain("AGENT_TOOL_CALLED");
  });

  it("prompt calls spend the same per-agent rate budget as tool calls", async () => {
    const w = await agentWorld("promptrate");
    const nodeId = await w.note(`限速-${w.stamp}`);
    const token = (await createToken(w.agent.id, { name: "reader", access: "read", issuedBy: w.owner.id })).plaintext;

    const outcomes: boolean[] = [];
    for (let i = 0; i < 65; i++) outcomes.push(Boolean((await rpc(token, "prompts/get", outline(nodeId))).error));
    expect(outcomes.filter(Boolean).length).toBeGreaterThanOrEqual(5);
    // The tools' bucket is the same one: a tool call is now refused too.
    const tool = await rpc(token, "tools/call", { name: "getNode", arguments: { id: nodeId } });
    expect(JSON.stringify(tool)).toMatch(/rate limit/i);
  });
});
