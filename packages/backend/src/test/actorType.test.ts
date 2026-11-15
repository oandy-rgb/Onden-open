import { describe, it, expect } from "vitest";
import { eventActorType, type ActorType } from "../types.js";

// ActorCtx.type comes from the DB (actors.type ∈ {'human','agent'}).
// event() actor_type column uses ∈ {'user','ai_agent','system'}.
// eventActorType bridges these two vocabularies for actor-driven emissions.
// (System-level automation events pass "system" explicitly at the call site.)
describe("eventActorType — ActorCtx.type → event() actor_type", () => {
  it("human → user", () => {
    expect(eventActorType("human")).toBe("user");
  });

  it("agent → ai_agent", () => {
    expect(eventActorType("agent")).toBe("ai_agent");
  });

  it("returns only valid event() actor_type values", () => {
    const all: ActorType[] = ["human", "agent"];
    const valid = new Set(["user", "ai_agent"]);
    for (const t of all) {
      expect(valid.has(eventActorType(t))).toBe(true);
    }
  });
});
