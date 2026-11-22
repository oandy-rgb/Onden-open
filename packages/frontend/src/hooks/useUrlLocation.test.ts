import { describe, it, expect, beforeEach } from "vitest";
import { resetAppState, setData } from "../lib/appStore";
import { parseLocation, locationToSearch, type AppLocation } from "./useUrlLocation";

const FALLBACK: AppLocation = { view: "notes", nodeId: null, lens: "editor" };

describe("parseLocation", () => {
  it("reads view + node + lens from the search string", () => {
    expect(parseLocation("?view=notes&node=abc-123&lens=canvas", FALLBACK)).toEqual({ view: "notes", nodeId: "abc-123", lens: "canvas" });
  });

  it("falls back per-field on missing/invalid values", () => {
    expect(parseLocation("", FALLBACK)).toEqual({ view: "notes", nodeId: null, lens: "editor" });
    expect(parseLocation("?view=bogus", FALLBACK)).toEqual({ view: "notes", nodeId: null, lens: "editor" });
    expect(parseLocation("?lens=bogus", FALLBACK).lens).toBe("editor");
    expect(parseLocation("?node=x", { view: "timeline", nodeId: null, lens: "canvas" })).toEqual({ view: "timeline", nodeId: "x", lens: "canvas" });
  });

  it("accepts every valid view + still-live lens", () => {
    for (const v of ["notes", "tasks", "website", "timeline", "graph"] as const) {
      expect(parseLocation(`?view=${v}`, FALLBACK).view).toBe(v);
    }
    // Canvas is a live lens again (gated per-node, but always a valid deep link).
    for (const l of ["editor", "canvas"] as const) {
      expect(parseLocation(`?lens=${l}`, FALLBACK).lens).toBe(l);
    }
  });

  it("opens an old ?lens=table link on the note's content (its sub-notes and their views are there now)", () => {
    expect(parseLocation("?view=notes&node=n1&lens=table", { view: "notes", nodeId: null, lens: "canvas" }))
      .toEqual({ view: "notes", nodeId: "n1", lens: "editor" });
  });

  it("keeps ?view=timeline resolving (no longer a Place, still a valid view)", () => {
    // The redundant Timeline Place was removed from the strip, but old deep
    // links + the mobile nav slot must still land on the merged TimelineLens
    // rather than 404 back to the fallback view.
    expect(parseLocation("?view=timeline", FALLBACK).view).toBe("timeline");
    expect(parseLocation("?view=timeline&node=n9", FALLBACK))
      .toEqual({ view: "timeline", nodeId: "n9", lens: "editor" });
  });

  it("?view=tags is no view any more (the sidebar lists tags): an old link falls back, keeping its node", () => {
    expect(parseLocation("?view=tags", FALLBACK).view).toBe("notes");
    expect(parseLocation("?view=tags&node=t1", { view: "tasks", nodeId: null, lens: "editor" }))
      .toEqual({ view: "tasks", nodeId: "t1", lens: "editor" });
  });

  it("passes the restored canvas lens through, still aliasing local-graph to editor", () => {
    // Canvas is back as a gated lens — its deep link resolves to itself.
    expect(parseLocation("?lens=canvas", FALLBACK).lens).toBe("canvas");
    expect(parseLocation("?view=notes&node=abc&lens=canvas", FALLBACK))
      .toEqual({ view: "notes", nodeId: "abc", lens: "canvas" });
    // local-graph stays aliased to editor (its this-note half is the inspector,
    // the everything-graph is a Place).
    expect(parseLocation("?lens=local-graph", FALLBACK).lens).toBe("editor");
    // A note's history is its time slider, not a lens: an old ?lens=timeline opens the editor,
    // and ?view=timeline still opens the workspace History.
    expect(parseLocation("?view=notes&node=abc&lens=timeline", FALLBACK)).toEqual({ view: "notes", nodeId: "abc", lens: "editor" });
    expect(parseLocation("?view=timeline", FALLBACK).view).toBe("timeline");
  });
});

describe("a module page's own place (lib/moduleAddress)", () => {
  it("is part of a module page's address (a reload and Back keep the review group) and of no other page's", () => {
    expect(locationToSearch({ view: "review", nodeId: null, lens: "editor" }, null, "tag.abc")).toBe("?view=review&m=tag.abc");
    expect(locationToSearch({ view: "review", nodeId: null, lens: "editor" }, null, null)).toBe("?view=review");
    // Leaving the page leaves its place behind.
    expect(locationToSearch({ view: "tasks", nodeId: null, lens: "editor" }, null, "tag.abc")).toBe("?view=tasks");
    expect(locationToSearch({ view: "notes", nodeId: "n1", lens: "editor" }, null, "tag.abc")).toBe("?view=notes&node=n1&lens=editor");
  });
});

describe("locationToSearch", () => {
  it("serializes view + lens (lens only in the node home), omitting node when null", () => {
    expect(locationToSearch({ view: "notes", nodeId: null, lens: "canvas" })).toBe("?view=notes&lens=canvas");
    expect(locationToSearch({ view: "notes", nodeId: "n1", lens: "editor" })).toBe("?view=notes&node=n1&lens=editor");
    // places carry no per-node lens
    expect(locationToSearch({ view: "tasks", nodeId: null, lens: "canvas" })).toBe("?view=tasks");
  });

  it("round-trips with parseLocation in the node home (live lenses)", () => {
    const cases: AppLocation[] = [
      { view: "notes", nodeId: null, lens: "editor" },
      { view: "notes", nodeId: "abc", lens: "canvas" },
      { view: "notes", nodeId: "uuid-with-dashes-0001", lens: "editor" },
    ];
    for (const loc of cases) {
      expect(parseLocation(locationToSearch(loc), FALLBACK)).toEqual(loc);
    }
  });

  it("url-encodes node ids that need it", () => {
    const loc: AppLocation = { view: "notes", nodeId: "a b/c", lens: "editor" };
    expect(parseLocation(locationToSearch(loc), FALLBACK)).toEqual(loc);
  });
});

// 「今天」 was a page from 2026-11-13 to 11-18. Every way into the app (an address, a history entry, the remembered
// place) reads its place through parseLocation, so the one rule lives there.
describe("an old view=today address", () => {
  const withModules = (modules: string[] | null) => setData((data) => ({ ...data, workspace: { ...data.workspace, modules } as typeof data.workspace }));
  beforeEach(() => resetAppState());

  it("opens 任務 when tasks are on", () => {
    withModules(["tasks", "daily"]);
    expect(parseLocation("?view=today", FALLBACK).view).toBe("tasks");
  });

  it("opens 日記 when only the journal is on", () => {
    withModules(["daily"]);
    expect(parseLocation("?view=today", FALLBACK).view).toBe("daily");
  });

  it("opens 筆記 when neither is on", () => {
    withModules([]);
    expect(parseLocation("?view=today", FALLBACK).view).toBe("notes");
  });

  it("opens 任務 before the workspace has said which modules are on (every module counts as on)", () => {
    expect(parseLocation("?view=today", FALLBACK).view).toBe("tasks");
  });

  it("keeps the rest of the address and is the same for a remembered place", () => {
    withModules(["tasks"]);
    expect(parseLocation("?view=today&node=n1", FALLBACK)).toEqual({ view: "tasks", nodeId: "n1", lens: "editor" });
  });
});
