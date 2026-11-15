import { bindAccountStorage } from "../../../lib/accountStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { defaultDesignV2, validateDesign, type PuckComponentData, type PuckData, type SiteDesign } from "@onden/site";
import type { Bootstrap } from "../../../lib/api";

vi.mock("../../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api")>();
  const api = vi.fn((_path: string, _init?: RequestInit): Promise<unknown> => Promise.resolve({}));
  const postRead = (path: string, body?: unknown, init: RequestInit = {}) =>
    api(path, { ...init, method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...mod, api, postRead };
});
vi.mock("../../../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../../../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertWorkspace: vi.fn(), upsertNode: vi.fn(), removeNode: vi.fn(),
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => {}),
}));
const mockSpaces = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../../../lib/spaces", async (original) => ({
  ...(await original<typeof import("../../../lib/spaces")>()),
  useSpaces: () => ({ spaces: mockSpaces.list, loaded: true }),
}));
import { api, ApiError, noWorkspaceData } from "../../../lib/api";
import { getAppState, setData } from "../../../lib/appStore";
import { setLocalePref } from "../../../lib/i18n";
import { setPending } from "../../../lib/data/syncStatus";
import { propertyWriter } from "../../../lib/data";
import { useHomeStudio } from "./useHomeStudio";
import { node, published, tag } from "./fixtures";

const apiMock = vi.mocked(api);
const tagA = tag({ id: "tA", name: "文章" });
const nodes = [
  node({ id: "home", title: "Home", attrs: published }),
  node({ id: "a1", title: "Alpha", attrs: published, class_tag_ids: ["tA"] }),
  node({ id: "a2", title: "Beta", attrs: published, class_tag_ids: ["tA"] }),
];
const makeData = (chrome?: Bootstrap["chrome"]): Bootstrap => ({
  ...noWorkspaceData,
  workspace: { id: "w1", name: "Test", slug: "default", home_node_id: "home" } as Bootstrap["workspace"],
  nodes, tags: [tagA], chrome, site_config: {},
});
const configPatches = () => apiMock.mock.calls.filter(([path, init]) => path === "/api/workspace/config" && init?.method === "PATCH");
const sentChrome = (index = 0) => JSON.parse(configPatches()[index]![1]!.body as string) as { chrome: SiteDesign & Record<string, unknown>; chrome_base?: string | null };

function mountStudio(data: Bootstrap) {
  setData(data);
  return renderHook(({ data: d }: { data: Bootstrap }) => useHomeStudio({ data: d, online: true, refresh: async () => {} }), { initialProps: { data } });
}
const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId: string): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full" } });
const home = (...content: PuckComponentData[]): PuckData => ({ root: { props: {} }, content });

beforeEach(() => {
  vi.useFakeTimers();
  bindAccountStorage("unit-test-account", "");
  setLocalePref("en"); setPending(0);
  mockSpaces.list = [];
  apiMock.mockClear();
  apiMock.mockImplementation(() => Promise.resolve({}));
});
afterEach(async () => {
  cleanup();
  await act(async () => { await vi.runAllTimersAsync(); });
  vi.useRealTimers();
});

describe("which design the studio opens on", () => {
  it("a chrome of the old studio (blocks) starts from the default design, computed from this device's notes, and saves nothing until the first change", async () => {
    const { result } = mountStudio(makeData({ blocks: [{ id: "x", type: "hero" }], studio_draft: true, rev: "old" }));
    expect(result.current.design).toEqual(defaultDesignV2({ homeNoteId: "home", topTagId: "tA" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(configPatches()).toHaveLength(0);
  });
  it("a v2 chrome is the design, with its revision", () => {
    const stored = { ...defaultDesignV2({ homeNoteId: "a1" }), rev: "r5", css: "h1{color:red}" };
    const { result } = mountStudio(makeData(stored));
    expect(result.current.design.rev).toBe("r5");
    expect(result.current.design.css).toBe("h1{color:red}");
  });
});

describe("notes of a space that cannot publish", () => {
  const closed = { id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } };
  const open = { id: "sp2", kind: "shared", is_default: true, name: "all", capabilities: { publish: true } };
  const mixed = (): Bootstrap => ({
    ...makeData(),
    nodes: [
      node({ id: "home", title: "Home", attrs: published, space_id: "sp1" }),
      node({ id: "a1", title: "Alpha", attrs: published, space_id: "sp2", class_tag_ids: ["tA"] }),
      node({ id: "a2", title: "Private", attrs: published, space_id: "sp1", class_tag_ids: ["tA"] }),
      node({ id: "a3", title: "Private too", attrs: published, space_id: "sp1", class_tag_ids: ["tA"] }),
    ],
  });
  it("are in no studio list and are not counted in a tag", () => {
    mockSpaces.list = [closed, open];
    const { result } = mountStudio(mixed());
    expect(result.current.notes.map((n) => n.id)).toEqual(["a1"]);
    expect(result.current.tags).toEqual([{ id: "tA", name: "文章", memberCount: 1 }]);
    expect(result.current.blocked.map((n) => n.id).sort()).toEqual(["a2", "a3", "home"]);
  });
  it("are not candidates of the default design, even the workspace home", () => {
    mockSpaces.list = [closed, open];
    const { result } = mountStudio({ ...mixed(), chrome: undefined });
    // "home" is the workspace home but sits in a closed space; the only open note is tagged, so there is no cover note
    expect(result.current.design).toEqual(defaultDesignV2({ topTagId: "tA" }));
  });
  it("come back once the space allows publishing", () => {
    mockSpaces.list = [{ ...closed, capabilities: { publish: true } }, open];
    const { result } = mountStudio(mixed());
    expect(result.current.notes.map((n) => n.id).sort()).toEqual(["a1", "a2", "a3", "home"]);
    expect(result.current.blocked).toEqual([]);
  });
});

describe("發布這篇 / 從網站移除", () => {
  it("publishNote marks the note 「發布」 with the same _published switch as the note's own button; unpublishNote keeps it off (「不發布」)", () => {
    const set = vi.spyOn(propertyWriter, "set").mockResolvedValue(undefined as never);
    const remove = vi.spyOn(propertyWriter, "remove").mockResolvedValue(undefined as never);
    const { result } = mountStudio(makeData());
    act(() => result.current.publishNote("a2"));
    expect(set).toHaveBeenCalledWith("a2", "_published", "true", { value_type: "bool", is_inheritable: false });
    act(() => result.current.unpublishNote("a2"));
    expect(set).toHaveBeenCalledWith("a2", "_published", "false", { value_type: "bool", is_inheritable: false });
    expect(remove).not.toHaveBeenCalled();
    set.mockRestore(); remove.mockRestore();
  });
});

describe("saving", () => {
  it("the first change saves the whole design as the chrome (v: 3, the free-form home page kept as legacy_home) against the old revision, once", async () => {
    const { result } = mountStudio(makeData({ blocks: [], studio_draft: true, rev: "old" }));
    act(() => result.current.setHome(home(part("stack", "s", { items: [note("n", "a1")] }))));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(configPatches()).toHaveLength(1);
    const body = sentChrome();
    expect(body.chrome_base).toBe("old");
    expect(body.chrome.v).toBe(3);
    expect(body.chrome.rev).not.toBe("old");
    expect(body.chrome).not.toHaveProperty("blocks");
    expect(body.chrome.legacy_home!.content[0]!.props.id).toBe("s");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(configPatches()).toHaveLength(1);
  });
  it("what is sent always passes validateDesign, whatever the editor held", async () => {
    const { result } = mountStudio(makeData());
    act(() => result.current.changeDesign((d) => ({ ...d, style: { ...d.style, scheme: "sepia" as never, accent: "red" }, css: "a {", home: home(note("loose", "a1"), part("stack", "s", { items: [part("stack", "i", { items: [part("stack", "j", { items: [] })] })] })) })));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const { chrome } = sentChrome();
    const { rev, ...rest } = chrome;
    void rev;
    expect(validateDesign(chrome).design).toEqual({ ...rest, rev: chrome.rev });
    expect(chrome.style).toEqual({ preset: "quiet", accent: "#3f7d6e", scheme: "system" });
    expect(chrome.legacy_home!.content.map((c) => c.type)).toEqual(["note", "stack"]);
  });
  it("edits within the delay are one save, and the next save names the revision just sent", async () => {
    const { result } = mountStudio(makeData({ blocks: [], rev: "old" }));
    act(() => result.current.changeDesign((d) => ({ ...d, css: "a{}" })));
    act(() => result.current.changeDesign((d) => ({ ...d, css: "b{}" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(configPatches()).toHaveLength(1);
    expect(sentChrome().chrome.css).toBe("b{}");
    act(() => result.current.changeDesign((d) => ({ ...d, css: "c{}" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(sentChrome(1).chrome_base).toBe(sentChrome(0).chrome.rev);
  });
  it("a save refused as stale shows the current design and is not sent again (D119)", async () => {
    const stored = { ...defaultDesignV2({}), rev: "r1" };
    const newer = { ...defaultDesignV2({}), rev: "r2", css: "from-other-device{}" };
    apiMock.mockImplementation(async (path, init) => {
      if (path === "/api/workspace/config" && init?.method === "PATCH") throw new ApiError(409, JSON.stringify({ error: "design_stale", detail: "changed elsewhere" }));
      if (path === "/api/workspace/config") return { config: {}, chrome: newer };
      return [];
    });
    const { result } = mountStudio(makeData(stored));
    const before = result.current.designVersion;
    act(() => result.current.changeDesign((d) => ({ ...d, css: "mine{}" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    await vi.waitFor(() => expect(result.current.design.css).toBe("from-other-device{}"));
    expect(result.current.designVersion).toBeGreaterThan(before);
    expect(getAppState().data.chrome).toMatchObject({ rev: "r2" });
    await act(async () => { await result.current.save.retry(); });
    expect(configPatches()).toHaveLength(1);
  });
  it("follows a design saved elsewhere while nothing here is unsaved", async () => {
    const { result, rerender } = mountStudio(makeData({ ...defaultDesignV2({}), rev: "r1" }));
    rerender({ data: makeData({ ...defaultDesignV2({}), rev: "r2", css: "later{}" }) });
    expect(result.current.design.css).toBe("later{}");
    expect(configPatches()).toHaveLength(0);
  });
  it("its own saved design coming back under the new rev keeps the editor (no reload, the selection stays)", async () => {
    const { result, rerender } = mountStudio(makeData({ ...defaultDesignV2({}), rev: "r1" }));
    act(() => result.current.changeDesign((d) => ({ ...d, css: "mine{}" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const sent = sentChrome().chrome;
    const before = result.current.designVersion;
    // The server's copy: same design, keys in its own (jsonb) order, the rev the save carried.
    const echoed = Object.fromEntries(Object.entries(sent).reverse()) as typeof sent;
    rerender({ data: makeData(echoed) });
    expect(result.current.designVersion).toBe(before);
    expect(result.current.design.css).toBe("mine{}");
    // …and a later design from elsewhere is still followed.
    rerender({ data: makeData({ ...sent, rev: "r9", css: "later{}" }) });
    expect(result.current.design.css).toBe("later{}");
    expect(result.current.designVersion).toBeGreaterThan(before);
  });
  it("does not replace an unsaved edit with a design from elsewhere", async () => {
    const { result, rerender } = mountStudio(makeData({ ...defaultDesignV2({}), rev: "r1" }));
    act(() => result.current.changeDesign((d) => ({ ...d, css: "mine{}" })));
    rerender({ data: makeData({ ...defaultDesignV2({}), rev: "r2", css: "later{}" }) });
    expect(result.current.design.css).toBe("mine{}");
  });
});

describe("publishing", () => {
  const preview = (refs: Array<{ componentId: string; noteId: string; title: string }>) => ({
    hash: "h", site: { title: "T", home_node_id: null, payload: { nodes: [] } }, live: null,
    diff: { added: [], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false },
    private_links: [], blocked_media: [], unpublished_refs: refs,
  });
  const calls = (path: string) => apiMock.mock.calls.filter(([p]) => p === path);

  it("Publish saves the design first, then previews; the body carries the site's settings, not the design", async () => {
    apiMock.mockImplementation(async (path) => (path === "/api/publish/preview" ? preview([]) : {}));
    const { result } = mountStudio(makeData());
    act(() => result.current.changeDesign((d) => ({ ...d, css: "a{}" })));
    await act(async () => { await result.current.publish.start(); });
    const order = apiMock.mock.calls.map(([path]) => path);
    expect(order.indexOf("/api/workspace/config")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("/api/workspace/config")).toBeLessThan(order.indexOf("/api/publish/preview"));
    const body = JSON.parse(calls("/api/publish/preview")[0]![1]!.body as string) as { presentation: Record<string, unknown> };
    expect(body.presentation).not.toHaveProperty("blocks");
    expect(body.presentation).not.toHaveProperty("design");
    expect(body.presentation).toHaveProperty("site");
    expect(result.current.publish.pending?.preview.unpublished_refs).toEqual([]);
  });

  it("一起發布 sends the note ids, then shows the preview again", async () => {
    let refs = [{ componentId: "c", noteId: "a2", title: "Beta" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/publish/preview") return preview(refs);
      if (path === "/api/publish/include") { refs = []; return { published: ["a2"], failed: [] }; }
      return {};
    });
    const { result } = mountStudio(makeData());
    await act(async () => { await result.current.publish.start(); });
    expect(result.current.publish.pending?.preview.unpublished_refs).toHaveLength(1);
    let done = false;
    await act(async () => { done = await result.current.publish.include(["a2"]); });
    expect(done).toBe(true);
    const include = calls("/api/publish/include");
    expect(include).toHaveLength(1);
    expect(JSON.parse(include[0]![1]!.body as string)).toEqual({ noteIds: ["a2"] });
    expect((include[0]![1]!.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(calls("/api/publish/preview")).toHaveLength(2);
    expect(result.current.publish.pending?.preview.unpublished_refs).toEqual([]);
  });

  it("a note the space will not publish is reported, the rest still go; the preview shows what is left", async () => {
    let refs = [{ componentId: "c", noteId: "a1", title: "Alpha" }, { componentId: "d", noteId: "a2", title: "Beta" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/publish/preview") return preview(refs);
      if (path === "/api/publish/include") { refs = [refs[1]!]; return { published: ["a1"], failed: [{ noteId: "a2", error: "space_not_publishable" }] }; }
      return {};
    });
    const { result } = mountStudio(makeData());
    await act(async () => { await result.current.publish.start(); });
    let done = true;
    await act(async () => { done = await result.current.publish.include(["a1", "a2"]); });
    expect(done).toBe(false);
    expect(result.current.publish.pending?.preview.unpublished_refs).toHaveLength(1);
    expect(getAppState().toasts.map((toast) => toast.message).join("|")).toContain("1 notes could not be published together");
  });

  it("a refused include leaves the preview as it was and reports false", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/publish/preview") return preview([{ componentId: "c", noteId: "a2", title: "Beta" }]);
      if (path === "/api/publish/include") throw new ApiError(403, JSON.stringify({ error: "forbidden" }));
      return {};
    });
    const { result } = mountStudio(makeData());
    await act(async () => { await result.current.publish.start(); });
    let done = true;
    await act(async () => { done = await result.current.publish.include(["a2"]); });
    expect(done).toBe(false);
    expect(calls("/api/publish/preview")).toHaveLength(1);
    expect(result.current.publish.pending?.preview.unpublished_refs).toHaveLength(1);
  });
});
