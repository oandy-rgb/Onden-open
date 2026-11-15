import { afterEach, describe, expect, it } from "vitest";
import { agentSessionsEnabled, assertSessionsEnabled, defaultAgentOf, replyBlockId } from "../services/agentSessions.js";

describe("agent sessions (no database)", () => {
  afterEach(() => { delete process.env.ONDEN_AGENT_SESSIONS; });

  it("names the reply block after the mention's block, one per revision", () => {
    expect(replyBlockId("s7k2", 1)).toBe("s7k2r");
    expect(replyBlockId("s7k2", 2)).toBe("s7k2r2");
  });

  it("ONDEN_AGENT_SESSIONS=off turns the feature off", () => {
    expect(agentSessionsEnabled()).toBe(true);
    process.env.ONDEN_AGENT_SESSIONS = "off";
    expect(agentSessionsEnabled()).toBe(false);
    expect(() => assertSessionsEnabled()).toThrow(/turned off/);
  });

  it("@ai means the oldest agent that can be sent to, else the oldest at all", () => {
    const rows = [{ id: "a", reason: "disabled" as const }, { id: "b", reason: null }, { id: "c", reason: null }];
    expect(defaultAgentOf(rows)?.id).toBe("b");
    expect(defaultAgentOf(rows.filter((r) => r.reason !== null))?.id).toBe("a");
    expect(defaultAgentOf([])).toBeNull();
  });
});
