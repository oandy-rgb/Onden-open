import { describe, expect, it } from "vitest";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { arrangeNavigation, getNavDestinations } from "../hooks/shellNavigation";
import { MODULES, moduleFilterFor, moduleInUse, moduleStatusFor } from "../modules";
import type { Tag } from "../lib/api";
import { usedFixture } from "./helpers/moduleUse";

// 「用到才出現」 (docs/architecture/module-library.md): 更多 lists every function
// that is on; the default layout bars one only once it is in use. Core pages
// never depend on it. "In use" is each module's library.inUse, else its module tag
// being used.

const noActions = { setMode: () => {}, onOpenModule: () => {}, onOpenFeature: () => {} };
const everyModuleOn = moduleFilterFor(null);
const ids = (features: ReturnType<typeof importedFeatures>) => features.map((f) => f.mod.id);
const none = { nodes: [], tags: [] };

describe("when a function is in use", () => {
  it("nothing is in use in an empty workspace", () => {
    for (const mod of MODULES) expect(moduleInUse(mod.id, none), mod.id).toBe(false);
  });

  it("the whiteboard: a board exists", () => {
    expect(moduleInUse("canvas", usedFixture(["canvas"]))).toBe(true);
  });

  it("RSS: a feed is subscribed", () => {
    expect(moduleInUse("rss", usedFixture(["rss"]))).toBe(true);
  });

  it("website: a note is marked for publishing", () => {
    expect(moduleInUse("website", usedFixture(["website"]))).toBe(true);
  });

  it("daily notes: a day note exists", () => {
    expect(moduleInUse("daily", usedFixture(["daily"]))).toBe(true);
    // A note merely titled like a date but hidden is not one.
    expect(moduleInUse("daily", { nodes: [{ id: "n", title: "2026-10-18", slug: "x", markdown: "", node_type: "content", source_type: "manual", hidden: true }], tags: [] })).toBe(false);
  });

  it("the rest: a tag adds the function, or a note carries its tag directly", () => {
    const reviewTag = { id: "m-review", name: "複習", color: "", schema_id: "m-review", schema_module: "review" } as Tag;
    // The module tag alone (made by turning the function on) is not use.
    expect(moduleInUse("review", { nodes: [], tags: [reviewTag] })).toBe(false);
    expect(moduleInUse("review", usedFixture(["review"]))).toBe(true);
    expect(moduleInUse("review", { nodes: [{ id: "n", title: "Card", slug: "c", markdown: "", node_type: "content", source_type: "manual", class_tag_ids: ["m-review"] }], tags: [reviewTag] })).toBe(true);
  });
});

describe("what the nav lists", () => {
  it("every function that is on is a feature; `inUse` only tells the default layout which to bar", () => {
    const features = importedFeatures(everyModuleOn, [], usedFixture(["rss", "review"]));
    expect(features.filter((f) => f.inUse).map((f) => f.mod.id)).toEqual(["review", "rss"]);
    expect(ids(features).length).toBeGreaterThan(2);
    const nav = getNavDestinations({ mode: "notes" }, noActions, importedFeatures(everyModuleOn, [], none));
    expect(nav.core.map((d) => d.id)).toEqual(["notes", "tasks", "graph", "timeline"]);
    expect(nav.modules.length).toBeGreaterThan(0);
  });

  it("the default layout bars the used functions only; the rest wait in 更多", () => {
    const nav = arrangeNavigation({ mode: "notes" }, noActions, importedFeatures(everyModuleOn, [], usedFixture(["review"])), null);
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "graph", "review", "today"]);
    expect(nav.unpinned.map((d) => d.id)).toContain("website");
    const bare = arrangeNavigation({ mode: "notes" }, noActions, importedFeatures(everyModuleOn, [], none), null);
    expect(bare.pinned.map((d) => d.id)).toEqual(["tasks", "graph", "today"]);
  });

  it("an edited layout keeps what the person pinned although nothing uses it", () => {
    const nav = arrangeNavigation({ mode: "notes" }, noActions, importedFeatures(everyModuleOn, [], none), { order: ["tasks", "website"], phone: 1 });
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "website"]);
  });

  it("a function that is off is not listed even when used", () => {
    const features = importedFeatures(moduleFilterFor(["review"]), [], usedFixture(["rss", "review"]));
    // (The inbox is a built-in module's page, but not a nav destination.)
    expect(ids(features)).toEqual(["review"]);
  });
});

describe("where each module stands", () => {
  it("on, off, and waiting for the owner's first yes", () => {
    const status = moduleStatusFor(["review"], ["rss"]);
    expect(status("review")).toBe("on");
    expect(status("rss")).toBe("ask");
    expect(status("skills")).toBe("off");
    // A view module and the whiteboard are on whether or not the list names them.
    expect(status("kanban")).toBe("on");
    expect(status("canvas")).toBe("on");
  });

  it("an older server that sends no list means everything is on", () => {
    expect(moduleStatusFor(undefined, undefined)("rss")).toBe("on");
  });
});
