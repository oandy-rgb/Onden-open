import { describe, expect, it, vi } from "vitest";
import {
  defaultNavLayout, isPinned, moveDestination, parseNavLayout, pinDestination, placeDestination,
  resolveNavLayout, swapPinned, unpinDestination, type NavLayout,
} from "../lib/navLayout";
import { arrangeNavigation, getMoreNavigationGroups, groupDestinations } from "../hooks/shellNavigation";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { moduleFilterFor } from "../modules";
import type { Tag } from "../lib/api";
import { usedFixture } from "./helpers/moduleUse";
import { createSyncedPrefStore, type SyncedPrefLocal, type SyncedPrefRemote } from "../lib/syncedPrefStore";

const createNavLayoutStore = (remote: SyncedPrefRemote<NavLayout>, local: SyncedPrefLocal<NavLayout>) => createSyncedPrefStore(remote, local, parseNavLayout);

// The navigation layout's rules (lib/navLayout) and where it is kept
// (lib/navLayoutStore). Every test builds its own data: nothing is shared.

const CANDIDATES = ["tasks", "tags", "graph", "timeline", "review", "reading", "canvas"];
const layout = (order: string[], phone: number): NavLayout => ({ order, phone });
const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
const features = (modules: string[]) => importedFeatures(moduleFilterFor(modules), []);

describe("the default layout is the navigation from before pins", () => {
  it("desktop: every core page then every module page; phone: only 任務 (標籤 is no destination: the sidebar lists tags)", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["review", "rss", "website", "canvas", "daily"]), null);
    // The whiteboard is on and has no destination: boards are notes.
    expect(nav.notes.id).toBe("notes");
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "graph", "review", "reading", "website", "daily"]);
    // 歷史 is the one core page left to 更多.
    expect(nav.unpinned.map((d) => d.id)).toEqual(["timeline"]);
    expect(nav.phoneBar.map((d) => d.id)).toEqual(["tasks"]);
  });

  it("follows what is imported until it is edited", () => {
    expect(arrangeNavigation({ mode: "notes" }, actions, features([]), null).pinned.map((d) => d.id)).toEqual(["tasks", "graph"]);
    expect(arrangeNavigation({ mode: "notes" }, actions, features(["website"]), null).pinned.map((d) => d.id)).toEqual(["tasks", "graph", "website"]);
  });

  it("the phone's 更多: 日記, 任務, 歷史 under 時間, Graph under 整理, every other feature under 功能; a pinned one leaves it", () => {
    const more = (stored: NavLayout | null) => {
      const nav = arrangeNavigation({ mode: "notes" }, actions, features(["rss", "daily"]), stored);
      return getMoreNavigationGroups({}, nav.phoneMore).map((g) => g.items.map((i) => i.id));
    };
    expect(more(null)).toEqual([["daily", "timeline"], ["graph"], ["reading"]]);
    expect(more(layout(["tasks", "reading"], 2))).toEqual([["daily", "timeline"], ["graph"]]);
    // 任務 sits between 日記 and 歷史 when it is not pinned.
    expect(more(layout(["graph", "reading"], 2))).toEqual([["daily", "tasks", "timeline"]]);
  });

  it("empty groups are not shown; a disabled feature is not in 時間", () => {
    const only = (modules: string[], stored: NavLayout | null, featureOn?: (f: string) => boolean) =>
      getMoreNavigationGroups({}, arrangeNavigation({ mode: "notes" }, actions, features(modules), stored, featureOn as never).phoneMore).map((g) => [g.id, g.items.map((i) => i.id)]);
    // Everything pinned except 歷史: only 時間 remains.
    expect(only([], layout(["tasks", "graph"], 2))).toEqual([["time", ["timeline"]]]);
    expect(only(["daily"], layout(["tasks", "graph"], 2))).toEqual([["time", ["daily", "timeline"]]]);
    // Daily notes off: not in 時間. Tasks off (feature off): not in 時間 either.
    expect(only([], null, (f) => f !== "tasks")).toEqual([["time", ["timeline"]], ["organize", ["graph"]]]);
  });

  it("the editor's grouping of 「在「更多」裡」 is the 更多 grouping", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["rss", "daily", "review"]), layout(["graph"], 1));
    const editor = groupDestinations(nav.unpinned).map((g) => [g.id, g.label, g.destinations.map((d) => d.id)]);
    const more = getMoreNavigationGroups({}, nav.unpinned).map((g) => [g.id, g.label, g.items.map((i) => i.id)]);
    expect(editor).toEqual(more);
    expect(editor[0]).toEqual(["time", "Time", ["daily", "tasks", "timeline"]]);
  });

  it("every 時間 destination carries the group itself (no id list in the grouping)", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["daily"]), null);
    const withGroup = nav.candidates.filter((d) => d.group?.id === "time").map((d) => d.id).sort();
    expect(withGroup).toEqual(["daily", "tasks", "timeline"]);
  });
});

describe("更多 and the nav editor's 「在「更多」裡」 are one list", () => {
  const used = usedFixture(["rss"]).tags;
  // Features on, only RSS in use: review and daily are on but unused.
  const featuresUsed = () => {
    const { nodes, subscriptions } = usedFixture(["rss"]);
    return importedFeatures(moduleFilterFor(["rss", "review", "daily"]), used, { nodes, tags: used, subscriptions });
  };
  const moreIds = (nav: ReturnType<typeof arrangeNavigation>) =>
    getMoreNavigationGroups({}, nav.phoneMore).flatMap((g) => g.items.filter((i) => i.destination).map((i) => i.id));

  it("default layout: an unused feature is in 更多, not in a bar; a used one is in the bar", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, featuresUsed(), null);
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "graph", "reading"]);
    expect(nav.unpinned.map((d) => d.id)).toEqual(["timeline", "review", "daily"]);
    expect(nav.phoneBar.map((d) => d.id)).toEqual(["tasks"]);
  });

  it("the same items, names and order as the editor's list; the reading hub once, named 閱讀", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, featuresUsed(), layout(["tasks"], 1));
    const groups = getMoreNavigationGroups({}, nav.phoneMore);
    const items = groups.flatMap((g) => g.items);
    expect(items.map((i) => [i.id, i.label])).toEqual(groupDestinations(nav.unpinned).flatMap((g) => g.destinations).map((d) => [d.id, d.label]));
    expect([...items.map((i) => i.id)].sort()).toEqual(nav.unpinned.map((d) => d.id).sort());
    expect(items.filter((i) => i.id === "reading").map((i) => i.label)).toEqual(["Reading"]);
    expect(groups.map((g) => g.id)).toEqual(["time", "organize", "features"]);
  });

  it("pinning removes it from both; a page pinned only past the phone's cut stays reachable on the phone", () => {
    const feats = featuresUsed();
    const pinnedReview = arrangeNavigation({ mode: "notes" }, actions, feats, layout(["tasks", "review"], 1));
    expect(pinnedReview.unpinned.map((d) => d.id)).not.toContain("review");
    expect(moreIds(pinnedReview)).toContain("review");
    const onBar = arrangeNavigation({ mode: "notes" }, actions, feats, layout(["tasks", "review"], 2));
    expect(onBar.unpinned.map((d) => d.id)).not.toContain("review");
    expect(moreIds(onBar)).not.toContain("review");
  });

  it("更多 is exactly the editor's 「在「更多」裡」 plus 「管理功能」; a feature with only a module tag is in neither", () => {
    const tag = { id: "t-rl", name: "技能", color: "", schema_id: "t-rl", schema_module: "skills" } as Tag;
    const feats = importedFeatures(moduleFilterFor(["skills", "rss"]), [tag]);
    const nav = arrangeNavigation({ mode: "notes" }, actions, feats, null);
    const items = getMoreNavigationGroups({ onManageModules: vi.fn() }, nav.phoneMore).flatMap((g) => g.items);
    expect(items.filter((i) => i.id !== "manage-modules").map((i) => i.id).sort()).toEqual(nav.phoneMore.map((d) => d.id).sort());
    expect(items.map((i) => i.id)).not.toContain("skills");
    expect(nav.candidates.map((d) => d.id)).not.toContain("skills");
    expect(items.at(-1)?.id).toBe("manage-modules");
  });
});

describe("pin, unpin, swap and reorder", () => {
  const base = defaultNavLayout(CANDIDATES);

  it("pinning on the phone joins the end of the bar and keeps the desktop order", () => {
    const result = pinDestination(base, "reading", "phone");
    expect(result).toEqual({ layout: layout(["tasks", "reading", "tags", "graph", "review", "canvas"], 2) });
    // Already in the bar: nothing changes.
    expect(pinDestination(layout(["tasks"], 1), "tasks", "phone")).toEqual({ layout: layout(["tasks"], 1) });
  });

  it("a full phone bar answers which entries could make room instead of changing", () => {
    const full = layout(["tasks", "tags", "reading", "graph"], 3);
    expect(pinDestination(full, "graph", "phone")).toEqual({ full: ["tasks", "tags", "reading"] });
    // The swap: the new one takes the slot, the old one moves just after the bar.
    expect(swapPinned(full, "graph", "tags")).toEqual(layout(["tasks", "graph", "reading", "tags"], 3));
    expect(swapPinned(full, "canvas", "tasks")).toEqual(layout(["canvas", "tags", "reading", "tasks", "graph"], 3));
    // Not a bar entry: no swap.
    expect(swapPinned(full, "canvas", "graph")).toBe(full);
  });

  it("unpinning on the phone leaves the desktop alone; on the desktop it leaves the list", () => {
    const pinned = layout(["tasks", "tags", "reading", "graph"], 3);
    expect(unpinDestination(pinned, "tags", "phone")).toEqual(layout(["tasks", "reading", "tags", "graph"], 2));
    expect(unpinDestination(pinned, "graph", "phone")).toBe(pinned);
    expect(unpinDestination(pinned, "tags", "desktop")).toEqual(layout(["tasks", "reading", "graph"], 2));
    expect(unpinDestination(pinned, "graph", "desktop")).toEqual(layout(["tasks", "tags", "reading"], 3));
    expect(pinDestination(layout(["tasks"], 1), "graph", "desktop")).toEqual({ layout: layout(["tasks", "graph"], 1) });
    expect(isPinned(pinned, "graph", "desktop")).toBe(true);
    expect(isPinned(pinned, "graph", "phone")).toBe(false);
  });

  it("moves an entry one place; the phone's cut is crossed on its own", () => {
    const l = layout(["tasks", "tags", "graph", "timeline"], 2);
    expect(moveDestination(l, "tags", -1)).toEqual(layout(["tags", "tasks", "graph", "timeline"], 2));
    expect(moveDestination(l, "tasks", -1)).toBe(l);
    expect(moveDestination(l, "timeline", 1)).toBe(l);
    // The first entry after the bar moving up joins it (room left) …
    expect(moveDestination(l, "graph", -1)).toEqual(layout(["tasks", "tags", "graph", "timeline"], 3));
    // … or trades places with the bar's last entry (bar full).
    const full = layout(["tasks", "tags", "graph", "timeline"], 3);
    expect(moveDestination(full, "timeline", -1)).toEqual(layout(["tasks", "tags", "timeline", "graph"], 3));
    // The bar's last entry moving down leaves the bar.
    expect(moveDestination(l, "tags", 1)).toEqual(layout(["tasks", "tags", "graph", "timeline"], 1));
    // Phone edits stay inside the bar.
    expect(moveDestination(l, "tags", 1, "phone")).toBe(l);
    expect(moveDestination(l, "tags", -1, "phone")).toEqual(layout(["tags", "tasks", "graph", "timeline"], 2));
  });

  it("drags across the drawn list, the cut moving with the rows", () => {
    // Drawn: tasks tags | graph timeline  (indexes 0 1 [2] 3 4)
    const l = layout(["tasks", "tags", "graph", "timeline"], 2);
    expect(placeDestination(l, "timeline", 0)).toEqual(layout(["timeline", "tasks", "tags", "graph"], 3));
    expect(placeDestination(l, "tasks", 5)).toEqual(layout(["tags", "graph", "timeline", "tasks"], 1));
    expect(placeDestination(l, "graph", 2)).toEqual(layout(["tasks", "tags", "graph", "timeline"], 3));
    // A full bar pushes its last entry past the cut.
    const full = layout(["tasks", "tags", "graph", "timeline"], 3);
    expect(placeDestination(full, "timeline", 0)).toEqual(layout(["timeline", "tasks", "tags", "graph"], 3));
  });
});

describe("a removed module", () => {
  it("drops out of the resolved layout without leaving a gap in the phone's bar", () => {
    const stored = layout(["tasks", "reading", "timeline", "graph", "website"], 3);
    expect(resolveNavLayout(stored, ["tasks", "tags", "graph", "timeline", "website"])).toEqual(layout(["tasks", "timeline", "graph", "website"], 2));
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["website"]), stored);
    expect(nav.phoneBar.map((d) => d.id)).toEqual(["tasks", "timeline"]);
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "timeline", "graph", "website"]);
    expect(nav.unpinned.map((d) => d.id)).toEqual([]);
  });

  it("a stored 今天 pin (the page was a trial until 2026-11-18) is dropped when read; the stored layout is left as it was", () => {
    const stored = layout(["tasks", "today", "graph", "website"], 2);
    const before = JSON.stringify(stored);
    expect(resolveNavLayout(stored, ["tasks", "graph", "timeline", "website"])).toEqual(layout(["tasks", "graph", "website"], 1));
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["website"]), stored);
    expect([...nav.pinned, ...nav.unpinned].map((d) => d.id)).not.toContain("today");
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("a pinned whiteboard (saved while it had a destination) is ignored, leaving no gap", () => {
    const stored = layout(["tasks", "canvas", "graph", "review"], 2);
    expect(resolveNavLayout(stored, ["tasks", "tags", "graph", "timeline", "review"])).toEqual(layout(["tasks", "graph", "review"], 1));
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["canvas", "review"]), stored);
    expect(nav.phoneBar.map((d) => d.id)).toEqual(["tasks"]);
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "graph", "review"]);
    expect([...nav.pinned, ...nav.unpinned].some((d) => d.id === "canvas")).toBe(false);
  });

  it("an edited layout does not take in modules imported later", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, features(["website", "review"]), layout(["tasks", "website"], 1));
    expect(nav.pinned.map((d) => d.id)).toEqual(["tasks", "website"]);
    expect(nav.unpinned.map((d) => d.id)).toEqual(["graph", "timeline", "review"]);
  });

  it("a stored 標籤 pin (an old layout) drops out: tags are no destination", () => {
    const stored = layout(["tasks", "tags", "graph"], 2);
    expect(resolveNavLayout(stored, ["tasks", "graph", "timeline"])).toEqual(layout(["tasks", "graph"], 1));
    const nav = arrangeNavigation({ mode: "notes" }, actions, features([]), stored);
    expect([...nav.pinned, ...nav.unpinned].map((d) => d.id)).not.toContain("tags");
  });

  it("reads back only well-formed layouts", () => {
    expect(parseNavLayout({ order: ["tasks"], phone: 1 })).toEqual(layout(["tasks"], 1));
    expect(parseNavLayout({ order: ["tasks"], phone: 3 })).toEqual(layout(["tasks"], 1));
    for (const bad of [null, "x", { order: "tasks", phone: 1 }, { order: [1], phone: 0 }, { order: [], phone: 4 }, { order: [], phone: 1.5 }]) {
      expect(parseNavLayout(bad)).toBeNull();
    }
  });
});

describe("the layout store", () => {
  function fakeLocal(scope: string | null = "account-a") {
    const saved = new Map<string, unknown>();
    const local: SyncedPrefLocal<NavLayout> = {
      scope: () => scope,
      read: () => saved.get(scope ?? "") ?? null,
      write: (value) => { saved.set(scope ?? "", JSON.parse(JSON.stringify(value))); },
    };
    return { local, saved };
  }
  function fakeRemote(initial: NavLayout | null = null) {
    let server = initial;
    let online = true;
    const remote: SyncedPrefRemote<NavLayout> = {
      load: vi.fn(async () => { if (!online) throw new Error("offline"); return server; }),
      save: vi.fn(async (next) => { if (!online) throw new Error("offline"); server = next; }),
    };
    return { remote, server: () => server, setOnline: (on: boolean) => { online = on; } };
  }

  it("round-trips: an edit lands in the local copy and on the server, and a new page reads it back", async () => {
    const { local } = fakeLocal();
    const server = fakeRemote();
    const store = createNavLayoutStore(server.remote, local);
    expect(store.get()).toEqual({ value: null, dirty: false, editedAt: null, settled: false });
    store.save(layout(["tasks", "reading"], 2));
    expect(store.get()).toMatchObject({ value: layout(["tasks", "reading"], 2), dirty: true });
    await store.sync();
    expect(store.get()).toEqual({ value: layout(["tasks", "reading"], 2), dirty: false, editedAt: null, settled: true });
    expect(server.server()).toEqual(layout(["tasks", "reading"], 2));
    // The next page on this device draws it before any request.
    const reopened = createNavLayoutStore(fakeRemote().remote, local);
    expect(reopened.get().value).toEqual(layout(["tasks", "reading"], 2));
  });

  it("another device takes the server's layout; 恢復預設 is null on both", async () => {
    const server = fakeRemote(layout(["graph"], 1));
    const store = createNavLayoutStore(server.remote, fakeLocal().local);
    await store.sync();
    expect(store.get()).toEqual({ value: layout(["graph"], 1), dirty: false, editedAt: null, settled: true });
    store.save(null);
    await store.sync();
    expect(server.server()).toBeNull();
    expect(store.get().value).toBeNull();
  });

  it("offline: the edit stays, marked dirty, and is sent on the next sync", async () => {
    const { local, saved } = fakeLocal();
    const server = fakeRemote(layout(["graph"], 1));
    server.setOnline(false);
    const store = createNavLayoutStore(server.remote, local);
    store.save(layout(["tasks", "tags", "canvas"], 3));
    await store.sync();
    expect(store.get()).toMatchObject({ value: layout(["tasks", "tags", "canvas"], 3), dirty: true, settled: false });
    expect(saved.get("account-a")).toEqual({ value: layout(["tasks", "tags", "canvas"], 3), dirty: true, editedAt: expect.any(Number) });
    // A reload while offline still has it.
    expect(createNavLayoutStore(server.remote, local).get()).toMatchObject({ value: layout(["tasks", "tags", "canvas"], 3), dirty: true });
    server.setOnline(true);
    await store.sync();
    // This device's edit wins over the older server copy.
    expect(server.server()).toEqual(layout(["tasks", "tags", "canvas"], 3));
    expect(store.get()).toEqual({ value: layout(["tasks", "tags", "canvas"], 3), dirty: false, editedAt: null, settled: true });
  });

  it("an edit made while the server's copy loads is kept and sent", async () => {
    const server = fakeRemote(layout(["graph"], 1));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowLoad = server.remote.load;
    server.remote.load = vi.fn(async () => { await gate; return slowLoad(); });
    const store = createNavLayoutStore(server.remote, fakeLocal().local);
    const loading = store.sync();
    store.save(layout(["timeline"], 1));
    release();
    await loading;
    expect(store.get()).toMatchObject({ value: layout(["timeline"], 1), dirty: false });
    expect(server.server()).toEqual(layout(["timeline"], 1));
  });

  it("keeps each account's copy apart, and holds it in memory before an account is bound", () => {
    const { local, saved } = fakeLocal(null);
    const store = createNavLayoutStore(fakeRemote().remote, local);
    store.save(layout(["graph"], 0));
    expect(store.get().value).toEqual(layout(["graph"], 0));
    expect(saved.size).toBe(0);
  });
});
