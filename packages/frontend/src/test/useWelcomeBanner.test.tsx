// The first-run welcome card: shown only on a workspace without notes until
// dismissed; its starter pack and intro-site opt-ins.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const writers = vi.hoisted(() => ({
  setModuleImported: vi.fn(),
  buildIntroSite: vi.fn(),
}));
vi.mock("../lib/data/domainWriters", async (original) => ({
  ...await original<typeof import("../lib/data/domainWriters")>(),
  workspaceWriter: { setModuleImported: writers.setModuleImported },
}));
vi.mock("../modules", async (original) => ({
  ...await original<typeof import("../modules")>(),
  SITE_PUBLISHER: { buildIntroSite: writers.buildIntroSite },
}));
const installTagPack = vi.hoisted(() => vi.fn());
vi.mock("../lib/moduleLibrary", async (original) => ({ ...await original<typeof import("../lib/moduleLibrary")>(), installTagPack }));
const imported = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("../hooks/useModuleFilter", () => ({ useModuleFilter: () => (id: string) => imported.ids.has(id) }));

import { useWelcomeBanner } from "../hooks/useWelcomeBanner";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { hintsSeenStore } from "../lib/hintsSeenStore";

const note = (id: string, title: string): ContentNode => ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content" });
const setup = () => {
  const refresh = vi.fn(async () => {});
  const setMode = vi.fn();
  const setNotesView = vi.fn();
  const hook = renderHook(() => useWelcomeBanner({ refresh, setMode, setNotesView }));
  return { ...hook, refresh, setMode, setNotesView };
};

beforeEach(() => {
  localStorage.clear();
  hintsSeenStore.save(null); // the seen-hints list outlives a test as the page does
  resetAppState();
  setAppState({ online: true, data: { ...noWorkspaceData, nodes: [] } });
  Object.values(writers).forEach((fn) => fn.mockReset());
  installTagPack.mockReset();
  imported.ids = new Set();
});

describe("useWelcomeBanner", () => {
  it("shows on an empty workspace until dismissed, and stays dismissed", () => {
    const first = setup();
    expect(first.result.current.visible).toBe(true);
    act(() => first.result.current.dismiss());
    expect(first.result.current.visible).toBe(false);
    first.unmount();
    expect(setup().result.current.visible).toBe(false);
  });

  it("does not show on a workspace that already has notes", () => {
    setAppState({ data: { ...noWorkspaceData, nodes: [note("a", "My note")] } });
    expect(setup().result.current.visible).toBe(false);
  });

  it("installs a starter pack and refreshes; a failure resolves false", async () => {
    const { result, refresh } = setup();
    installTagPack.mockResolvedValueOnce(undefined);
    await expect(result.current.installStarterPack({ tags: [] }, "Reading list")).resolves.toBe(true);
    expect(refresh).toHaveBeenCalled();
    installTagPack.mockRejectedValueOnce(new Error("nope"));
    await expect(result.current.installStarterPack({ tags: [] }, "Reading list")).resolves.toBe(false);
  });

  it("builds the intro site through the site module, then opens Home", async () => {
    imported.ids = new Set(["website"]);
    writers.buildIntroSite.mockResolvedValueOnce({ url: "/site/home", homeId: "home-1" });
    const { result, setMode, setNotesView } = setup();
    let url: string | null = null;
    await act(async () => { url = await result.current.buildIntroSite(); });
    expect(url).toBe("/site/home");
    expect(writers.setModuleImported).not.toHaveBeenCalled();
    expect(getAppState().selectedId).toBe("home-1");
    expect(setMode).toHaveBeenCalledWith("notes");
    expect(setNotesView).toHaveBeenCalledWith("editor");
  });

  it("when the publish would carry other notes, opens the Website screen and does not open Home or return a link", async () => {
    imported.ids = new Set(["website"]);
    writers.buildIntroSite.mockResolvedValueOnce({ needsReview: true, homeId: "home-1" });
    const { result, setMode } = setup();
    let url: string | null = "unset";
    await act(async () => { url = await result.current.buildIntroSite(); });
    expect(url).toBeNull();
    expect(setMode).toHaveBeenCalledWith("website");
    expect(setMode).not.toHaveBeenCalledWith("notes");
  });

  it("without the website module, points at Settings › Modules instead of importing it", async () => {
    const opened = vi.fn();
    window.addEventListener("onden:open-settings", opened);
    const { result } = setup();
    let url: string | null = "unset";
    await act(async () => { url = await result.current.buildIntroSite(); });
    window.removeEventListener("onden:open-settings", opened);
    expect(url).toBeNull();
    expect(writers.setModuleImported).not.toHaveBeenCalled();
    expect(writers.buildIntroSite).not.toHaveBeenCalled();
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toBe("modules");
  });

  it("keeps the card up once the build started, though the workspace now has notes", async () => {
    imported.ids = new Set(["website"]);
    writers.buildIntroSite.mockImplementationOnce(async () => {
      setAppState({ data: { ...getAppState().data, nodes: [note("home-1", "Home")] } });
      return null;
    });
    const { result, setMode } = setup();
    let url: string | null = "unset";
    await act(async () => { url = await result.current.buildIntroSite(); });
    expect(url).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
    expect(result.current.visible).toBe(true);
  });
});
