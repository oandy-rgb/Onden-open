import { describe, expect, it } from "vitest";
import { ProtocolError } from "./protocol.mjs";
import { runLoop } from "./loop.mjs";

const claim = { session: { id: "s1", deadline_at: new Date(Date.now() + 60_000).toISOString() }, rendered: { system: "S", messages: [{ role: "user", content: "q" }] }, mcp: { path: "/api/mcp/protocol", token: "ondt_session" } };

describe("loop states (what the desktop app shows)", () => {
  it("reports waiting, answering, then waiting again", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    let polls = 0;
    const client = {
      pending: async () => (++polls === 1 ? ["s1"] : (controller.abort(), [])),
      claim: async () => claim, event: async () => ({}), status: async () => ({ status: "running" }), finish: async () => ({}),
    };
    const adapter = { id: "x", label: "x", detect: async () => ({ ok: true as const, command: "x" }), run: async () => ({ ok: true as const, text: "a" }) };
    await runLoop({ client: client as never, adapter, baseUrl: "http://127.0.0.1:1", signal: controller.signal, onState: (s) => states.push(s), sleep: async () => {} });
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(["waiting", "answering", "waiting"]);
  });

  it("reports refused for 401 and unreachable for a network failure, sleeping 60 s and 15 s", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const waits: number[] = [];
    const errors = [new ProtocolError(401, "unauthorized"), new ProtocolError(0, "network")];
    const client = { pending: async () => { throw errors.shift() ?? (controller.abort(), new ProtocolError(0, "network")); } };
    const adapter = { id: "x", label: "x", detect: async () => ({ ok: true as const, command: "x" }), run: async () => ({ ok: false as const, reason: "empty" as const }) };
    await runLoop({ client: client as never, adapter, baseUrl: "http://127.0.0.1:1", signal: controller.signal, onState: (s) => states.push(s), sleep: async (ms) => { waits.push(ms); } });
    expect(states).toContain("refused");
    expect(states).toContain("unreachable");
    expect(waits.slice(0, 2)).toEqual([60_000, 15_000]);
  });
});
