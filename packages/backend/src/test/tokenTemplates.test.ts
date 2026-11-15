// Token access levels: `read` and `write` expand to tool lists derived from the
// registry (services/agentTools/templates.ts). Pins (a) every expanded tool is
// registered, (b) write ⊃ read, (c) read carries no write or publish tool,
// (d) publishSite belongs to neither, (e) the exact lists today — a tool added
// later must declare its access and this file shows the change.

import { describe, it, expect } from "vitest";
import { TOKEN_ACCESS_LEVELS, isTokenAccess, listTools, toolsForAccess } from "../services/agentTools/index.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// publishSite and the module tools come from the shipped modules.
registerShippedModules();

describe("token access levels", () => {
  it("are read and write", () => {
    expect([...TOKEN_ACCESS_LEVELS]).toEqual(["read", "write"]);
  });

  it("every expanded tool is registered", () => {
    const known = new Set(listTools().map((t) => t.name));
    for (const access of TOKEN_ACCESS_LEVELS) {
      for (const tool of toolsForAccess(access)) expect(known.has(tool), `${access} → ${tool} must be registered`).toBe(true);
    }
  });

  it("write includes every read tool and adds some", () => {
    const read = new Set(toolsForAccess("read"));
    const write = new Set(toolsForAccess("write"));
    for (const t of read) expect(write.has(t), `write must include ${t}`).toBe(true);
    expect(write.size).toBeGreaterThan(read.size);
  });

  it("read carries no write tool; the agent has no publish tool at all (the owner publishes)", () => {
    const byName = new Map(listTools().map((t) => [t.name, t.access]));
    for (const t of toolsForAccess("read")) expect(byName.get(t), `read must not carry ${t}`).toBe("read");
    for (const t of toolsForAccess("write")) expect(["read", "write"]).toContain(byName.get(t));
    expect(byName.has("publishSite")).toBe(false);
  });

  it("the lists today (a new tool must declare its access; this shows what it changes)", () => {
    expect(toolsForAccess("read").sort()).toEqual(
      ["getAttachment", "getNode", "getSessionLog", "getSlides", "listChildren", "listMySessions", "listSpaces", "listSuggestions", "loadSkill", "queryView", "reviewQueue", "searchNodes", "semanticSearch", "suggestLinks"]);
    expect(toolsForAccess("write").sort()).toEqual(
      ["applyTag", "commentOnNote", "createNode", "getAttachment", "getNode", "getSessionLog", "getSlides", "listChildren", "listMySessions", "listSpaces", "listSuggestions", "loadSkill", "proposeTagPack", "queryView", "removeTag", "reviewQueue", "searchNodes", "semanticSearch", "setSlideLayout", "suggestEdit", "suggestLinks", "updateNode"]);
  });

  it("isTokenAccess guards the route input", () => {
    expect(isTokenAccess("read")).toBe(true);
    expect(isTokenAccess("admin")).toBe(false);
    expect(isTokenAccess(null)).toBe(false);
  });
});
