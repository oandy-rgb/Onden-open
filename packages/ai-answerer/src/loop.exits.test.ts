// Every way out of a claimed question ends in exactly one outcome sent to the server (or nothing when the server already ended it).
import { describe, expect, it } from "vitest";
import { ProtocolError } from "./protocol.mjs";
import { runLoop } from "./loop.mjs";

type Sent = { status: string; fail_code?: string; result_markdown?: string };
const claim = { session: { id: "s1", deadline_at: new Date(Date.now() + 600_000).toISOString() }, rendered: { system: "S", messages: [{ role: "user", content: "q" }] }, mcp: { path: "/api/mcp/protocol", token: "ondt_session" } };

async function run(opts: {
  tool: (input: { signal?: AbortSignal; mcpUrl: string }) => Promise<unknown>;
  ack?: () => Promise<unknown>;
  finish?: (outcome: Sent) => Promise<unknown>;
  status?: () => Promise<{ status: string }>;
  stopWhenRunning?: boolean;
  baseUrl?: string;
}) {
  const controller = new AbortController();
  const sent: Sent[] = [];
  const urls: string[] = [];
  let polls = 0;
  const client = {
    pending: async () => (++polls === 1 ? ["s1"] : (controller.abort(), [])),
    claim: async () => claim,
    event: opts.ack ?? (async () => ({})),
    status: opts.status ?? (async () => ({ status: "running" })),
    finish: async (_id: string, _key: string, outcome: Sent) => { sent.push(outcome); return opts.finish ? opts.finish(outcome) : {}; },
  };
  const adapter = { id: "x", label: "x", detect: async () => ({ ok: true as const, command: "x" }), run: async (input: { signal?: AbortSignal; mcpUrl: string }) => { urls.push(input.mcpUrl); if (opts.stopWhenRunning) setTimeout(() => controller.abort(), 20); return opts.tool(input); } };
  await runLoop({ client: client as never, adapter: adapter as never, baseUrl: opts.baseUrl ?? "http://127.0.0.1:1", signal: controller.signal, sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), cancelPollMs: 10 });
  return { sent, urls };
}
const hang = (input: { signal?: AbortSignal }) => new Promise((resolve) => input.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" })));

describe("a claimed question always ends", () => {
  it("answered → completed", async () => {
    expect((await run({ tool: async () => ({ ok: true, text: "a" }) })).sent).toEqual([{ status: "completed", result_markdown: "a" }]);
  });
  it.each(["empty", "not_json", "tool_error", "timeout", "not_started", "too_long"])("the tool gave no answer (%s) → failed", async (reason) => {
    expect((await run({ tool: async () => ({ ok: false, reason }) })).sent).toEqual([{ status: "failed", fail_code: "agent_error" }]);
  });
  it("the adapter throws → failed", async () => {
    expect((await run({ tool: async () => { throw new Error("boom"); } })).sent).toEqual([{ status: "failed", fail_code: "agent_error" }]);
  });
  it("an answer the server refuses (too long, 422) → failed with its reason, not a silent wait", async () => {
    const { sent } = await run({ tool: async () => ({ ok: true, text: "x" }), finish: async (o) => { if (o.status === "completed") throw new ProtocolError(422, "reply_too_long"); } });
    expect(sent).toEqual([{ status: "completed", result_markdown: "x" }, { status: "failed", fail_code: "reply_too_long" }]);
  });
  it("another refused answer → failed (reply_rejected)", async () => {
    const { sent } = await run({ tool: async () => ({ ok: true, text: "x" }), finish: async (o) => { if (o.status === "completed") throw new ProtocolError(400, "invalid_log"); } });
    expect(sent.at(-1)).toEqual({ status: "failed", fail_code: "reply_rejected" });
  });
  it("the program is stopped while the tool runs → failed (stopped), the tool was told to stop", async () => {
    expect((await run({ tool: hang, stopWhenRunning: true })).sent).toEqual([{ status: "failed", fail_code: "stopped" }]);
  });
  it("the person cancels (the server ended it) → nothing to send", async () => {
    expect((await run({ tool: hang, status: async () => ({ status: "cancelled" }) })).sent).toEqual([]);
  });
  it("the ack fails for a reason that is not 'already over' → failed; if already over → nothing", async () => {
    expect((await run({ tool: async () => ({ ok: true, text: "a" }), ack: async () => { throw new ProtocolError(500, "http_error"); } })).sent).toEqual([{ status: "failed", fail_code: "agent_error" }]);
    expect((await run({ tool: async () => ({ ok: true, text: "a" }), ack: async () => { throw new ProtocolError(409, "session_ended"); } })).sent).toEqual([]);
  });
  it("the tool is given the MCP address under the server's own path", async () => {
    const { urls } = await run({ tool: async () => ({ ok: true, text: "a" }), baseUrl: "https://host/onden" });
    expect(urls).toEqual(["https://host/onden/api/mcp/protocol"]);
  });
});
