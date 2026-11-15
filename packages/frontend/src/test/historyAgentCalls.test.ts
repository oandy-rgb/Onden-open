import { describe, expect, it } from "vitest";
import { eventSentence } from "../lib/history/eventSentence";
import { foldAgentCalls } from "../lib/history/agentCalls";
import { groupEvents } from "../lib/history/groupEvents";
import type { LiveEvent } from "../lib/liveEvent";

const titles = new Map([["n1", "_代修清單"]]);
const ctx = { titleOf: (id: string) => titles.get(id), agentNameOf: (id: string) => (id === "a1" ? "Claude" : undefined) };

function ev(over: Partial<LiveEvent>): LiveEvent {
  return {
    id: 100, actor_type: "ai_agent", actor_id: "a1", event_type: "AGENT_TOOL_CALLED", target_type: "tool",
    target_id: "updateNode", payload: { ok: true, duration_ms: 3 }, created_at: "2026-10-22T01:55:00Z",
    tx_meta: { tool_name: "updateNode", token_id: "89156edd", args: { keys: ["id"], ids: { id: "n1" } } }, ...over,
  };
}

describe("agent tool call sentences", () => {
  it("names the agent, the tool in words and the note", () => {
    expect(eventSentence(ev({}), ctx)).toBe("Claude edited 「_代修清單」");
    expect(eventSentence(ev({ target_id: "applyTag", tx_meta: { tool_name: "applyTag", args: { keys: [], ids: { nodeId: "n1" } } } }), ctx))
      .toBe("Claude tagged 「_代修清單」");
  });
  it("falls back to a generic agent name and note", () => {
    expect(eventSentence(ev({ actor_id: "zz", tx_meta: { tool_name: "updateNode" } }), ctx)).toBe("AI edited a note");
  });
  it("says why a failed call failed, without raw JSON, ids or durations", () => {
    const failed = ev({ event_type: "AGENT_TOOL_FAILED", payload: { ok: false, duration_ms: 0, scope_rejected: true, message: "x" } });
    const sentence = eventSentence(failed, ctx);
    expect(sentence).toBe("Claude wanted to edit 「_代修清單」, but had no permission");
    expect(sentence).not.toMatch(/\{|89156edd|duration|keys/);
    expect(eventSentence(ev({ event_type: "AGENT_TOOL_FAILED", payload: { message: "Rate limit exceeded" } }), ctx)).toMatch(/called too often/);
    expect(eventSentence(ev({ event_type: "AGENT_TOOL_FAILED", payload: { message: "boom" } }), ctx)).toMatch(/it did not work/);
  });
  it("prefixes an agent's own change with its name, and leaves a person's alone", () => {
    const change = ev({ id: 99, event_type: "NODE_UPDATED", target_type: "node", target_id: "n1", payload: {}, tx_meta: { tool_name: "updateNode" } });
    expect(eventSentence(change, ctx)).toBe("Claude edited 「_代修清單」");
    expect(eventSentence({ ...change, actor_type: "user", actor_id: "u" }, ctx)).toBe("Edited 「_代修清單」");
  });
});

describe("foldAgentCalls", () => {
  const change = ev({ id: 99, event_type: "NODE_UPDATED", target_type: "node", target_id: "n1", payload: {}, tx_meta: { tool_name: "updateNode" } });
  it("folds a write call into the change it made", () => {
    expect(foldAgentCalls([ev({}), change]).map((e) => e.id)).toEqual([99]);
  });
  it("keeps a call whose change is not in view, or another agent's", () => {
    expect(foldAgentCalls([ev({})]).map((e) => e.id)).toEqual([100]);
    expect(foldAgentCalls([ev({}), { ...change, actor_id: "a2" }]).map((e) => e.id)).toEqual([100, 99]);
  });
  it("never folds a failure", () => {
    expect(foldAgentCalls([ev({ event_type: "AGENT_TOOL_FAILED" }), change]).map((e) => e.id)).toEqual([100, 99]);
  });
  it("lets edits by the agent still group", () => {
    const older = { ...change, id: 90 };
    expect(groupEvents(foldAgentCalls([ev({}), change, older])).map((r) => r.kind)).toEqual(["edits"]);
  });
});
