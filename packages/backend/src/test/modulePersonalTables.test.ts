// Removing a member deletes their per-person module progress (routes/actors.ts).
// Which tables that covers is each module's own declaration
// (ModuleDefinition.personalTables), not a list in core (W7).
import { describe, it, expect } from "vitest";
import { MODULES, registerModuleEffects } from "../modules/index.js";
import { registeredPersonalTables } from "../services/moduleCatalog.js";

describe("module personal tables", () => {
  it("the shipped modules declare the per-actor tables of migrations 092 and 120", () => {
    expect(MODULES.flatMap((m) => m.personalTables ?? []).sort())
      .toEqual(["external_calendars", "focus_sessions", "review_states", "rss_mutes", "rss_seen"]);
  });

  it("registering the modules gives core the tables to clear when a member is removed", () => {
    for (const mod of MODULES) registerModuleEffects(mod);
    expect(registeredPersonalTables().sort())
      .toEqual(["external_calendars", "focus_sessions", "review_states", "rss_mutes", "rss_seen"]);
  });

  it("routes/actors.ts no longer names a module's table", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../routes/actors.ts", import.meta.url), "utf8");
    for (const table of ["review_states", "rss_seen"]) expect(src).not.toContain(table);
  });
});
