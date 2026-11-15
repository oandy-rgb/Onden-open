import { bindAccountStorage } from "../../../lib/accountStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultDesign, defaultDesignV2, validateDesign, type PuckComponentData, type SiteDesign, type SiteDesignV2 } from "@onden/site";
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
const mockSpaces = vi.hoisted(() => ({ list: [] as import("../../../lib/spaces").Space[] }));
vi.mock("../../../lib/spaces", async (original) => ({
  ...(await original<typeof import("../../../lib/spaces")>()),
  useSpaces: () => ({ spaces: mockSpaces.list, loaded: true }),
}));
vi.mock("../../../components/markdownSurfaces", () => ({
  makeMarkdownRenderer: () => (markdown: string) => <div data-md="">{markdown}</div>,
}));
const uploadMedia = vi.hoisted(() => vi.fn(async (_file: File) => "/api/media/phone-logo.png"));
const viewsList = vi.hoisted(() => vi.fn(async (_owner: unknown) => ({ views: [] as Array<{ id: string; name: string; layout: string }> })));
vi.mock("../../../lib/data", async (original) => {
  const mod = await original<typeof import("../../../lib/data")>();
  // The module reads (publish preview, site) stay real: they go through the
  // mocked lib/api above, which answers the preview.
  return { ...mod, uploadMedia, reads: { ...mod.reads, views: { list: viewsList }, notes: { full: vi.fn(async () => ({ markdown: "" })) } } };
});
// The preview inside the publish dialog is not under test here.
vi.mock("../studio/PublishedHomePreview", () => ({ default: () => <div>site preview</div> }));

import { api, noWorkspaceData } from "../../../lib/api";
import { resetAppState, setData, useAppSelector } from "../../../lib/appStore";
import { setLocalePref } from "../../../lib/i18n";
import { setPending } from "../../../lib/data/syncStatus";
import { node, published, tag } from "../studio/fixtures";
import { useHomeStudio } from "../studio/useHomeStudio";
import PhoneHomeStudio from "./PhoneHomeStudio";

const apiMock = vi.mocked(api);
const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId: string): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full" } });
const tagView = (id: string, tagId: string): PuckComponentData => ({ type: "tag_view", props: { id, tagId, viewId: "", viewKind: "list", limit: 6, sort: "new" } });

const tagA = tag({ id: "tA", name: "文章" });
const tagB = tag({ id: "tB", name: "作品" });
const nodes = [
  node({ id: "alpha", title: "Alpha", attrs: published, class_tag_ids: ["tA"], markdown: "# Alpha\n\nAlpha words" }),
  node({ id: "beta", title: "Beta", attrs: published, class_tag_ids: ["tB"], markdown: "# Beta\n\nBeta words" }),
  node({ id: "draft", title: "Draft", markdown: "# Draft\n\nSecret draft words" }),
];
const startDesign: SiteDesignV2 = {
  ...defaultDesignV2({}),
  rev: "r1",
  home: { root: { props: {} }, content: [
    part("stack", "s1", { items: [note("n1", "alpha")] }),
    part("stack", "s2", { items: [tagView("v1", "tA")] }),
    part("sidebar", "s3", { aside: [note("n2", "alpha")], main: [tagView("v2", "tA")] }),
    part("stack", "s4", { items: [note("n4", "draft")] }),
  ] },
};
const makeData = (chrome: unknown = startDesign): Bootstrap => ({
  ...noWorkspaceData,
  workspace: { id: "w1", name: "Test", slug: "default", home_node_id: "alpha" } as Bootstrap["workspace"],
  nodes, tags: [tagA, tagB], chrome: chrome as Bootstrap["chrome"], site_config: {},
});

function Screen({ online = true }: { online?: boolean }) {
  const data = useAppSelector((s) => s.data);
  const site = useHomeStudio({ data, online, refresh: async () => {} });
  return <PhoneHomeStudio site={site} />;
}
const configPatches = () => apiMock.mock.calls.filter(([path, init]) => path === "/api/workspace/config" && init?.method === "PATCH");
const lastSaved = () => JSON.parse(configPatches().at(-1)![1]!.body as string) as { chrome: SiteDesign; chrome_base?: string };
const saveNow = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
const rowTitles = () => [...document.querySelectorAll(".ph-block__title")].map((el) => el.textContent);
const row = (id: string) => document.querySelector(`[data-block="${id}"]`) as HTMLElement;
const preview = {
  hash: "h", site: { title: "T", home_node_id: null, payload: { nodes: [{ id: "alpha", title: "Alpha", slug: "alpha" }] } }, live: null,
  diff: { added: [], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false },
  private_links: [], blocked_media: [], unpublished_refs: [],
};

beforeEach(() => {
  bindAccountStorage("unit-test-account", "");
  setLocalePref("zh-TW"); setPending(0); mockSpaces.list = [];
  resetAppState({ data: makeData(), online: true });
  setData(makeData());
  apiMock.mockReset();
  apiMock.mockImplementation(async (path) => (path === "/api/publish/preview" ? preview : {}));
  viewsList.mockClear();
  viewsList.mockImplementation(async () => ({ views: [] }));
});
afterEach(async () => {
  cleanup();
  resetAppState();
});

describe("the list", () => {
  it("shows the top-level blocks in order, in plain words, and nested ones as one row", () => {
    render(<Screen />);
    expect(rowTitles()).toEqual(["Alpha", "標籤檢視：文章", "側欄", "Draft（未發布）"]);
    expect(row("s3")).toHaveTextContent("Alpha、標籤檢視：文章");
    expect(document.body.textContent).not.toMatch(/\bs[1-4]\b|\bn[1-4]\b|\bv[12]\b/);
  });
  it("draws the page below with the site's components: an unpublished note only as 未發布", () => {
    render(<Screen />);
    const page = screen.getByTestId("phone-preview");
    expect(within(page).getAllByText(/Alpha words/).length).toBeGreaterThan(0);
    expect(within(page).getByText("未發布")).toBeInTheDocument();
    expect(page.textContent).not.toContain("Secret draft words");
    expect(page.querySelector(".site-scope")).not.toBeNull();
  });
});

describe("logo and site icon", () => {
  it("has both fields, and an upload is saved with the site's other settings", async () => {
    setLocalePref("zh-TW");
    render(<Screen />);
    const logo = screen.getByRole("group", { name: "標誌" });
    expect(screen.getByRole("group", { name: "網站圖示" })).toHaveTextContent("瀏覽器分頁上的小圖示");
    fireEvent.change(logo.querySelector("input[type=file]")!, { target: { files: [new File(["x"], "logo.png", { type: "image/png" })] } });
    await waitFor(() => expect(within(logo).getByRole("img")).toHaveAttribute("src", "/api/media/phone-logo.png"));
    await saveNow();
    const { config } = JSON.parse(configPatches().at(-1)![1]!.body as string) as { config: Record<string, unknown> };
    expect(config.logo).toBe("/api/media/phone-logo.png");
    expect(config).not.toHaveProperty("favicon");
  });
});

describe("what the phone does not offer", () => {
  it("has no part creation, nesting, drag, CSS, per-part settings or desktop hint", () => {
    render(<Screen />);
    const text = document.body.textContent ?? "";
    for (const word of ["全站 CSS", "進階", "class", "到電腦", "版面零件", "拖", "展開成零件", "標題比例", "自選重點色", "內文字級"]) expect(text).not.toContain(word);
    expect(document.querySelector("textarea, [data-puck-component], [data-rfd-draggable-id], [draggable=true]")).toBeNull();
    // Nothing offers to add a part: the insert sheet lists only block patterns.
    fireEvent.click(screen.getByRole("button", { name: "插入區塊範本" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(["關閉", "介紹＋近況", "作品卡片", "三欄入口", "時間軸區塊"]);
  });
  it("a block holding several things can only be moved or deleted", () => {
    render(<Screen />);
    expect(within(row("s3")).getAllByRole("button").map((b) => b.textContent)).toEqual(["上移", "下移", "刪除"]);
    expect(within(row("s1")).getAllByRole("button").map((b) => b.textContent)).toEqual(["上移", "下移", "換筆記", "刪除"]);
    expect(within(row("s2")).getAllByRole("button").map((b) => b.textContent)).toEqual(["上移", "下移", "換標籤檢視", "刪除"]);
  });
});

describe("each action saves a valid design through the desktop studio's writer, against the revision it opened on", () => {
  const savedValid = () => {
    const { chrome } = lastSaved();
    expect(validateDesign(chrome).problems).toEqual([]);
    expect(validateDesign(chrome).design).toEqual(chrome);
    return chrome;
  };
  it("moves a block down", async () => {
    render(<Screen />);
    fireEvent.click(within(row("s1")).getByRole("button", { name: /下移/ }));
    expect(rowTitles().slice(0, 2)).toEqual(["標籤檢視：文章", "Alpha"]);
    await saveNow();
    expect(configPatches()).toHaveLength(1);
    expect(lastSaved().chrome_base).toBe("r1");
    expect(savedValid().legacy_home!.content.map((c) => c.props.id)).toEqual(["s2", "s1", "s3", "s4"]);
  });
  it("moves a block up; the first block's 上移 is off", () => {
    render(<Screen />);
    expect(within(row("s1")).getByRole("button", { name: /上移/ })).toBeDisabled();
    expect(within(row("s4")).getByRole("button", { name: /下移/ })).toBeDisabled();
  });
  it("deletes a block only after asking", async () => {
    render(<Screen />);
    fireEvent.click(within(row("s3")).getByRole("button", { name: /^刪除/ }));
    expect(rowTitles()).toHaveLength(4);
    fireEvent.click(within(row("s3")).getByRole("button", { name: /取消/ }));
    expect(rowTitles()).toHaveLength(4);
    fireEvent.click(within(row("s3")).getByRole("button", { name: /^刪除/ }));
    fireEvent.click(within(row("s3")).getByRole("button", { name: /確定刪除/ }));
    expect(rowTitles()).toEqual(["Alpha", "標籤檢視：文章", "Draft（未發布）"]);
    await saveNow();
    expect(savedValid().legacy_home!.content.map((c) => c.props.id)).toEqual(["s1", "s2", "s4"]);
  });
  it("swaps a block's note, choosing only among published notes", async () => {
    render(<Screen />);
    fireEvent.click(within(row("s1")).getByRole("button", { name: /換筆記/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByText("Draft")).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("搜尋…"), { target: { value: "bet" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Beta" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowTitles()[0]).toBe("Beta");
    await saveNow();
    const chrome = savedValid();
    expect((chrome.legacy_home!.content[0]!.props.items as PuckComponentData[])[0]!.props.noteId).toBe("beta");
    expect(lastSaved().chrome_base).toBe("r1");
  });
  it("swaps a tag view: the tag, then one of its views", async () => {
    viewsList.mockImplementation(async () => ({ views: [{ id: "vw1", name: "作品牆", layout: "gallery" }] }));
    render(<Screen />);
    fireEvent.click(within(row("s2")).getByRole("button", { name: /換標籤檢視/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /作品/ }));
    fireEvent.click(await screen.findByRole("button", { name: "作品牆" }));
    expect(rowTitles()[1]).toBe("標籤檢視：作品");
    await saveNow();
    const props = (savedValid().legacy_home!.content[1]!.props.items as PuckComponentData[])[0]!.props;
    expect(props).toMatchObject({ tagId: "tB", viewId: "vw1", viewKind: "cards" });
  });
  it("a tag with no saved views is chosen at once, with its default view", async () => {
    render(<Screen />);
    fireEvent.click(within(row("s2")).getByRole("button", { name: /換標籤檢視/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /作品/ }));
    await waitFor(() => expect(rowTitles()[1]).toBe("標籤檢視：作品"));
    await saveNow();
    expect((savedValid().legacy_home!.content[1]!.props.items as PuckComponentData[])[0]!.props).toMatchObject({ tagId: "tB", viewId: "" });
  });
  it("inserts a block pattern at the chosen position once its content is chosen", async () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole("button", { name: "插入區塊範本" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "三欄入口" }));
    const insert = () => screen.getByRole("button", { name: "插入" });
    expect(insert()).toBeDisabled();
    for (const noteTitle of ["Alpha", "Beta", "Alpha"]) {
      fireEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^筆記/ }).find((b) => /還沒選/.test(b.textContent ?? ""))!);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: noteTitle }));
    }
    fireEvent.change(screen.getByLabelText("放在哪裡"), { target: { value: "1" } });
    expect(insert()).toBeEnabled();
    fireEvent.click(insert());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowTitles()[1]).toBe("三欄入口");
    await saveNow();
    const chrome = savedValid();
    const block = chrome.legacy_home!.content[1]!;
    expect(block.type).toBe("pattern_three_entries");
    expect(["a", "b", "c"].map((slot) => (block.props[slot] as PuckComponentData[])[0]!.props.noteId)).toEqual(["alpha", "beta", "alpha"]);
  });
  it("the style is the same three choices as the desktop: 氣質, 重點色, 配色 (and nothing else)", async () => {
    render(<Screen />);
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    const preset = within(screen.getByRole("group", { name: "氣質" }));
    expect(preset.getAllByRole("button").map((b) => b.textContent)).toEqual(["安靜無襯線，留白多", "紙本襯線，像書頁", "書冊標題大，內文無襯線", "手寫楷書，圓角"]);
    fireEvent.click(preset.getByRole("button", { name: /書冊/ }));
    await saveNow();
    expect(savedValid().style).toEqual({ preset: "folio", accent: "#3f7d6e", scheme: "system" });
    expect((document.querySelector(".site-scope") as HTMLElement).style.getPropertyValue("--s-font-h")).toContain("Noto Serif TC");

    const accent = within(screen.getByRole("group", { name: "重點色" }));
    expect(accent.getAllByRole("button")).toHaveLength(6);
    fireEvent.click(accent.getByRole("button", { name: "紅" }));
    await saveNow();
    expect(savedValid().style).toMatchObject({ preset: "folio", accent: "#b23a2a" });
    expect((document.querySelector(".site-scope") as HTMLElement).style.getPropertyValue("--s-accent")).toBeTruthy();

    const scheme = within(screen.getByRole("group", { name: "配色" }));
    expect(scheme.getAllByRole("button").map((b) => b.textContent)).toEqual(["跟隨訪客系統", "淺色", "深色"]);
    fireEvent.click(scheme.getByRole("button", { name: "深色" }));
    await saveNow();
    expect(savedValid().style).toEqual({ preset: "folio", accent: "#b23a2a", scheme: "dark" });
    expect(lastSaved().chrome_base).not.toBe("r1");
  });
});

describe("publish", () => {
  it("goes through the preview first and publishes only when confirmed there", async () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole("button", { name: "發布" }));
    const dialog = await screen.findByRole("dialog");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/publish/preview")).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/publish")).toBe(false);
    expect(dialog).toBeInTheDocument();
    // Nothing on the screen publishes by itself; the dialog's own button does.
    fireEvent.click(dialog.querySelector(".publish-preview-confirm")!);
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === "/api/publish")).toBe(true));
  });
  it("cancelling the preview publishes nothing", async () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole("button", { name: "發布" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel|取消/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiMock.mock.calls.some(([path]) => path === "/api/publish")).toBe(false);
  });
  it("is off while offline", () => {
    render(<Screen online={false} />);
    expect(screen.getByRole("button", { name: "發布" })).toBeDisabled();
  });
});

describe("a save refused as stale", () => {
  it("shows the newer design instead of sending the edit again", async () => {
    const newer = { ...defaultDesignV2({}), rev: "r2", home: { root: { props: {} }, content: [part("stack", "z", { items: [note("nz", "beta")] })] } };
    apiMock.mockImplementation(async (path, init) => {
      if (path === "/api/workspace/config" && init?.method === "PATCH") {
        const { ApiError } = await import("../../../lib/api");
        throw new ApiError(409, JSON.stringify({ error: "design_stale", detail: "changed elsewhere" }));
      }
      if (path === "/api/workspace/config") return { config: {}, chrome: newer };
      return {};
    });
    render(<Screen />);
    fireEvent.click(within(row("s1")).getByRole("button", { name: /下移/ }));
    await saveNow();
    await waitFor(() => expect(rowTitles()).toEqual(["Beta"]));
    expect(configPatches()).toHaveLength(1);
  });
});

describe("phone polish", () => {
  it("shows the save status through t(): zh-TW says 網站變更已同步", async () => {
    setLocalePref("zh-TW");
    render(<Screen />);
    fireEvent.click(within(row("s2")).getByRole("button", { name: /上移/ }));
    await saveNow();
    expect(document.querySelector(".ph-save")).toHaveTextContent("網站變更已同步");
    expect(document.body.textContent).not.toContain("Website changes");
  });
  it("presents the pickers as a full-width bottom sheet", () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole("button", { name: "插入區塊範本" }));
    const sheet = screen.getByRole("dialog");
    expect(sheet.closest(".ui-modal")).not.toBeNull();
    expect(sheet.querySelector(".shell-dialog.ph-sheet")).not.toBeNull();
  });
  it("says why the note picker is empty when every marked note is kept off the site", () => {
    mockSpaces.list = [{ id: "sp1", name: "x", kind: "personal", is_default: true, owner_actor_id: null, capabilities: { publish: false }, permission: "edit", can_manage: true } as never];
    setData({ ...makeData(), nodes: nodes.map((n) => ({ ...n, space_id: "sp1" })) } as Bootstrap);
    setLocalePref("zh-TW");
    render(<Screen />);
    fireEvent.click(within(row("s1")).getByRole("button", { name: /換筆記/ }));
    const reason = screen.getByTestId("phone-blocked-reason");
    expect(reason).toHaveTextContent("有 2 篇標了發布，但放在不允許發布的空間（只有我）。");
    expect(reason.textContent).not.toMatch(/alpha|beta|sp1/);
  });
  it("shows a placeholder, not a blank box, when the layout has no content", () => {
    setData(makeData({ ...defaultDesign(), preset: null, rev: "r1", legacy_home: { root: { props: {} }, content: [] } }));
    render(<Screen />);
    const page = screen.getByTestId("phone-preview");
    expect(page).toHaveTextContent("加入區塊後，這裡會顯示首頁的樣子。");
    expect(page.querySelector(".site-scope")).toBeNull();
  });
});

describe("content on the top level", () => {
  it("is listed, moved and saved without a stack around it", async () => {
    const flat: SiteDesignV2 = {
      ...startDesign,
      home: { root: { props: {} }, content: [note("n1", "alpha"), tagView("v1", "tA"), part("sidebar", "s3", { aside: [note("n2", "alpha")], main: [tagView("v9", "tA")] })] },
    };
    resetAppState({ data: makeData(flat), online: true });
    setData(makeData(flat));
    render(<Screen />);
    expect(rowTitles()).toEqual(["Alpha", "標籤檢視：文章", "側欄"]);
    expect(within(row("n1")).getAllByRole("button").map((b) => b.textContent)).toEqual(["上移", "下移", "換筆記", "刪除"]);
    expect(within(row("n1")).getByRole("button", { name: /上移/ })).toBeDisabled();
    fireEvent.click(within(row("n1")).getByRole("button", { name: /下移/ }));
    expect(rowTitles()).toEqual(["標籤檢視：文章", "Alpha", "側欄"]);
    await saveNow();
    const { chrome } = lastSaved();
    expect(validateDesign(chrome).design).toEqual(chrome);
    expect(chrome.legacy_home!.content.map((c) => c.type)).toEqual(["tag_view", "note", "sidebar"]);
  });
  it("is drawn in the page below like the same content in its own stack", () => {
    const flat: SiteDesignV2 = { ...startDesign, home: { root: { props: {} }, content: [note("n1", "alpha")] } };
    resetAppState({ data: makeData(flat), online: true });
    setData(makeData(flat));
    render(<Screen />);
    const page = screen.getByTestId("phone-preview");
    expect(page.querySelector('[data-node="top-n1"].s-part.s-stack')).not.toBeNull();
    expect(within(page).getAllByText(/Alpha words/).length).toBeGreaterThan(0);
  });
});
