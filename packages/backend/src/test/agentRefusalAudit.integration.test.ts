// A token that keeps getting refused (not allowed, rate limited) writes one
// audit row per reason per minute, not one per attempt: domain_events is
// append-only. The refusals themselves still happen every time.
//
// SAFETY: the integration part skips unless DATABASE_URL points at a *_test database.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { _resetRateLimits } from "../services/agentTools/rateLimit.js";
import { _resetAuditOnce, auditRefusalOnce } from "../services/agentTools/auditOnce.js";
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

const call = (token: string) => app.request("/api/mcp/tools/getNode", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }),
});
const failures = async (agentId: string) => (await q<{ payload: { message: string } }>(
  `SELECT payload FROM domain_events WHERE actor_id = $1 AND event_type = 'AGENT_TOOL_FAILED'`, [agentId])).rows;

describe("auditRefusalOnce", () => {
  it("lets one refusal per token and reason through each minute", () => {
    expect(auditRefusalOnce("t1", "tool_not_allowed", 0)).toBe(true);
    expect(auditRefusalOnce("t1", "tool_not_allowed", 59_999)).toBe(false);
    expect(auditRefusalOnce("t1", "rate_limited", 100)).toBe(true); // another reason
    expect(auditRefusalOnce("t2", "tool_not_allowed", 100)).toBe(true); // another token
    expect(auditRefusalOnce("t1", "tool_not_allowed", 60_000)).toBe(true); // next window
  });
});

describe.skipIf(!isTestDb)("refused agent calls", () => {
  it("a locked token is refused every time but audited once", async () => {
    const w = await agentWorld("refuseonce");
    const token = (await createToken(w.agent.id, { name: "locked", access: "read", allowedTools: [], issuedBy: w.owner.id })).plaintext;
    for (let i = 0; i < 6; i++) expect((await call(token)).status).toBe(403);
    expect(await failures(w.agent.id)).toHaveLength(1);
  });

  it("a rate-limited token adds one more row for that reason, not one per refusal", async () => {
    const w = await agentWorld("refuserate");
    const token = (await createToken(w.agent.id, { name: "reader", access: "read", issuedBy: w.owner.id })).plaintext;
    const statuses: number[] = [];
    for (let i = 0; i < 75; i++) statuses.push((await call(token)).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
    const rows = await failures(w.agent.id);
    expect(rows.filter((r) => /rate limit/i.test(r.payload.message))).toHaveLength(1);
  });
});
