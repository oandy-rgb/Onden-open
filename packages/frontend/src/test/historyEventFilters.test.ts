import { describe, expect, it } from "vitest";
import { activeFilters, clearFilter, NO_FILTERS } from "../lib/history/eventFilters";

describe("event filters", () => {
  it("has no active chips by default", () => {
    expect(activeFilters(NO_FILTERS)).toEqual([]);
  });
  it("lists each set filter in a stable order", () => {
    const f = { actor: "ai_agent" as const, type: "TAG_APPLIED", deletedOnly: false };
    expect(activeFilters(f).map((a) => a.key)).toEqual(["actor", "type"]);
    expect(activeFilters({ ...f, deletedOnly: true }).map((a) => a.key)).toEqual(["deleted", "actor"]);
  });
  it("hides the type filter while the Deleted view is on (it has no types)", () => {
    expect(activeFilters({ actor: "", type: "TAG_APPLIED", deletedOnly: true }).map((a) => a.key)).toEqual(["deleted"]);
  });
  it("removing a chip clears only its filter", () => {
    const f = { actor: "user" as const, type: "TAG_APPLIED", deletedOnly: false };
    expect(clearFilter(f, "actor")).toEqual({ actor: "", type: "TAG_APPLIED", deletedOnly: false });
    expect(clearFilter(f, "type")).toEqual({ actor: "user", type: "", deletedOnly: false });
    expect(clearFilter({ ...f, deletedOnly: true }, "deleted").deletedOnly).toBe(false);
  });
});
