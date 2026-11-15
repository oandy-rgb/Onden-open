// @vitest-environment jsdom
import "../../../test/puckEnv";
import { holdAnchored } from "../../../test/helpers/anchoredText";
import { PREFS } from "../../../lib/prefs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { colorVars, defaultDesignV2, type PuckComponentData, type SiteDesignV2 } from "@onden/site";
import { noWorkspaceData } from "../../../lib/api";
import { resetAppState } from "../../../lib/appStore";
import { setLocalePref } from "../../../lib/i18n";
import { node, published, tag } from "./fixtures";

vi.mock("../../../components/markdownSurfaces", () => ({
  makeMarkdownRenderer: () => (markdown: string) => <div data-md="">{markdown}</div>,
}));
vi.mock("../../../lib/spaces", async (original) => ({
  ...(await original<typeof import("../../../lib/spaces")>()),
  useSpaces: () => ({ spaces: [], loaded: true }),
}));
vi.mock("../../../lib/capabilities", async (original) => ({
  ...(await original<typeof import("../../../lib/capabilities")>()),
  useCapabilities: () => ({ canEdit: () => true }),
}));
vi.mock("../../../components/EmbedEditSheet", () => ({
  default: ({ embed }: { embed: { blockId: string } }) => <div role="dialog" aria-label="edit sheet">editing ^{embed.blockId}</div>,
}));
const viewsList = vi.hoisted(() => vi.fn(async (_owner: unknown) => ({ views: [] as Array<{ id: string; name: string; layout: string }> })));
vi.mock("../../../lib/data", async (original) => ({
  ...(await original<typeof import("../../../lib/data")>()),
  reads: { views: { list: viewsList }, notes: { full: vi.fn(async () => ({ markdown: "" })) } },
}));

const { PART_TYPES, PATTERN_TYPES } = await import("@onden/site");
const { ASSET_INFO } = await import("./assetInfo");
const { default: HomeStudio } = await import("./HomeStudio");
type HomeStudioState = import("./useHomeStudio").HomeStudioState;
const { studioNotes, studioTags } = await import("./editorData");

const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full", ...extra } });

const tagA = tag({ id: "tA", name: "文章" });
const nodes = [
  node({ id: "alpha", title: "Alpha", attrs: published, label_tag_ids: ["tA"], markdown: holdAnchored("alpha", "# Alpha\n\nAlpha words ^p1") }),
  node({ id: "draft", title: "Draft", markdown: "# Draft\n\nSecret draft words" }),
];

function makeSite(design: SiteDesignV2, over: Partial<HomeStudioState> = {}): HomeStudioState {
  return {
    online: true,
    notes: studioNotes(nodes, []), tags: studioTags(nodes, [tagA], []), blocked: [],
    design, designVersion: 0,
    setHome: vi.fn(), changeDesign: vi.fn(), applyDesign: vi.fn(),
    settings: { value: { brand: "My site", tagline: "" } as never, set: vi.fn() },
    bodies: new Map(), wantBodies: vi.fn(),
    save: { status: "idle", retry: vi.fn(async () => true) },
    publish: { start: vi.fn(async () => {}), pending: null, loading: false, confirm: vi.fn(async () => {}), cancel: vi.fn(), status: "idle", url: null, include: vi.fn(async () => true) },
    publishNote: vi.fn(), unpublishNote: vi.fn(),
    ...over,
  } as HomeStudioState;
}
const designOf = (...content: PuckComponentData[]): SiteDesignV2 => ({ ...defaultDesignV2({}), home: { root: { props: {} }, content } });
const mount = (site: HomeStudioState, onOpenNode = vi.fn()) => render(<HomeStudio site={site} onOpenNode={onOpenNode} />);

beforeEach(() => {
  setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes, tags: [tagA] }, online: true });
});
afterEach(() => { cleanup(); resetAppState(); });

describe("the canvas", () => {
  const design = designOf(part("stack", "s", { items: [note("n-alpha", "alpha"), note("n-draft", "draft")] }));
  it("draws a published note's words and an unpublished note as its title and a 未發布 mark, never its words", async () => {
    mount(makeSite(design));
    const canvas = document.querySelector(".hs-canvas__frame") as HTMLElement;
    await waitFor(() => expect(within(canvas).getByText(/Alpha words/)).toBeInTheDocument());
    const cell = canvas.querySelector('[data-node="n-draft"]') as HTMLElement;
    expect(within(cell).getByText("Draft")).toBeInTheDocument();
    expect(within(cell).getByText("未發布")).toBeInTheDocument();
    expect(canvas.textContent).not.toContain("Secret draft words");
  });
  it("draws content on the top level in a default stack, like the published page, and only content in a layout can select its parent", async () => {
    mount(makeSite(designOf(note("n-top", "alpha"), part("stack", "s", { items: [note("n-in", "alpha")] }))));
    const canvas = document.querySelector(".hs-canvas__frame") as HTMLElement;
    await waitFor(() => expect(canvas.querySelectorAll('[data-puck-component="n-top"]')).toHaveLength(1));
    expect(canvas.querySelector('[data-node="n-top"]')).not.toBeNull();
    await select("n-top");
    expect(screen.queryByRole("button", { name: "選取上一層" })).toBeNull();
    await select("n-in");
    expect(await screen.findByRole("button", { name: "選取上一層" })).toBeInTheDocument();
  });
  it("is inside .site-scope with the design's style variables and scoped CSS", async () => {
    const styled = { ...design, css: "p { color: red; }" };
    mount(makeSite(styled));
    const scope = document.querySelector(".site-scope") as HTMLElement;
    expect(scope.style.getPropertyValue("--s-accent")).toBe(colorVars(styled.style, "light")["--s-accent"]);
    expect(scope.style.getPropertyValue("--s-bg")).toBe(colorVars(styled.style, "light")["--s-bg"]);
    expect(scope.querySelector("style")!.textContent).toContain("@scope (.site-scope) {");
    expect(scope.querySelector("style")!.textContent).toContain("p { color: red; }");
  });
  it("switches between the desktop and the phone width", async () => {
    mount(makeSite(design));
    const frame = document.querySelector(".hs-canvas__frame") as HTMLElement;
    expect(frame.dataset.width).toBe("desktop");
    fireEvent.click(screen.getByRole("button", { name: "手機" }));
    await waitFor(() => expect(frame.dataset.width).toBe("phone"));
    expect(frame.style.getPropertyValue("--hs-width")).toBe("390px");
    fireEvent.click(screen.getByRole("button", { name: "桌面" }));
    await waitFor(() => expect(frame.dataset.width).toBe("desktop"));
  });
  it("double-clicking a note with a paragraph id opens that paragraph's source for editing", async () => {
    mount(makeSite(designOf(part("stack", "s", { items: [note("n-quote", "alpha", { blockId: "p1" })] }))));
    const target = await waitFor(() => { const el = document.querySelector('[data-node="n-quote"]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.doubleClick(target);
    expect(await screen.findByRole("dialog", { name: "edit sheet" })).toHaveTextContent("editing ^p1");
  });
  it("double-clicking a whole note opens it in the app (「到筆記裡改」)", async () => {
    const onOpenNode = vi.fn();
    mount(makeSite(design), onOpenNode);
    const target = await waitFor(() => { const el = document.querySelector('[data-node="n-alpha"]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.doubleClick(target);
    expect(onOpenNode).toHaveBeenCalledWith("alpha");
  });
});

describe("網站設定", () => {
  const panel = () => screen.getByRole("tabpanel");
  /** The style the studio would save for the one change it made. */
  const changed = (site: HomeStudioState) => vi.mocked(site.changeDesign).mock.calls.at(-1)![0](site.design).style;

  it("there are two tabs, 屬性 and 建議; with nothing selected 屬性 holds the site's settings", () => {
    mount(makeSite(designOf()));
    expect(within(screen.getByRole("tablist", { name: "面板" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["屬性", "建議"]);
    expect(screen.queryByRole("tab", { name: "風格" })).toBeNull();
    const settings = within(panel());
    expect(settings.getByLabelText("網站名稱")).toHaveValue("My site");
    for (const group of ["氣質", "重點色", "配色"]) expect(settings.getByRole("group", { name: group })).toBeInTheDocument();
  });
  it("only the three choices: no sliders, fonts, ratios, variables or class lists", () => {
    mount(makeSite(designOf()));
    const settings = within(panel());
    expect(settings.queryAllByRole("slider")).toHaveLength(0);
    expect(settings.queryAllByRole("combobox")).toHaveLength(0);
    expect(settings.queryAllByRole("radio")).toHaveLength(0);
    for (const gone of ["內文字級", "標題比例", "間距", "標題字體", "內文字體", "圓角", "可以用的變數與 class", "變數（目前的值）", "網站的 class"]) expect(settings.queryByText(gone)).toBeNull();
    expect(panel().textContent).not.toMatch(/--s-|\.s-card/);
  });
  it("氣質: four cards (name and sentence), the choice keeps the accent and scheme", () => {
    const site = makeSite(designOf());
    mount(site);
    const group = within(screen.getByRole("group", { name: "氣質" }));
    expect(group.getAllByRole("button").map((b) => b.textContent)).toEqual(["安靜無襯線，留白多", "紙本襯線，像書頁", "書冊標題大，內文無襯線", "手寫楷書，圓角"]);
    expect(group.getByRole("button", { name: /安靜/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(group.getByRole("button", { name: /紙本/ }));
    expect(site.changeDesign).toHaveBeenCalledTimes(1);
    expect(changed(site)).toEqual({ ...site.design.style, preset: "paper" });
  });
  it("重點色: six swatches and 自訂", () => {
    const site = makeSite(designOf());
    mount(site);
    const group = within(screen.getByRole("group", { name: "重點色" }));
    expect(group.getAllByRole("button")).toHaveLength(6);
    fireEvent.click(group.getByRole("button", { name: "橘" }));
    expect(changed(site).accent).toBe("#e8772e");
    fireEvent.change(group.getByLabelText("自訂"), { target: { value: "#123456" } });
    expect(changed(site).accent).toBe("#123456");
  });
  it("配色: 跟隨訪客系統 (the default), 淺色, 深色", () => {
    const site = makeSite(designOf());
    mount(site);
    const group = within(screen.getByRole("group", { name: "配色" }));
    expect(group.getAllByRole("button").map((b) => b.textContent)).toEqual(["跟隨訪客系統", "淺色", "深色"]);
    expect(group.getByRole("button", { name: "跟隨訪客系統" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(group.getByRole("button", { name: "深色" }));
    expect(changed(site).scheme).toBe("dark");
  });
  it("the site's name and one-line intro are the first two fields", () => {
    const site = makeSite(designOf());
    mount(site);
    const fields = panel().querySelectorAll("input[type='text'], input:not([type])");
    expect([...fields].slice(0, 2).map((f) => (f as HTMLInputElement).id)).toEqual([
      screen.getByLabelText("網站名稱").id, screen.getByLabelText("一句話介紹").id,
    ]);
    fireEvent.change(screen.getByLabelText("一句話介紹"), { target: { value: "hello" } });
    expect(site.settings.set).toHaveBeenCalledTimes(1);
  });
  it("every control in the panel has a label tied to it", () => {
    mount(makeSite(designOf()));
    for (const control of panel().querySelectorAll("input, select, textarea")) {
      const labelled = (control.id && panel().querySelector(`label[for="${control.id}"]`)) || control.closest("label") || control.closest("fieldset");
      expect(labelled, control.outerHTML).toBeTruthy();
    }
  });
  it("site CSS is under a folded 「自己寫樣式」; it goes to the design, and unbalanced CSS says so and is not applied", () => {
    const site = makeSite(designOf());
    const { rerender } = mount(site);
    const folded = screen.getByText("自己寫樣式").closest("details") as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    fireEvent.change(screen.getByLabelText(/寫在這裡的樣式/), { target: { value: "h1 { color: red }" } });
    expect(vi.mocked(site.changeDesign).mock.calls[0]![0](site.design).css).toBe("h1 { color: red }");
    expect(screen.queryByText("大括號沒有配對，先不套用")).toBeNull();

    rerender(<HomeStudio site={makeSite({ ...site.design, css: "h1 { color: red" })} onOpenNode={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("大括號沒有配對，先不套用");
    expect(document.querySelector(".site-scope style")!.textContent).not.toContain("h1 { color: red");
  });
});

describe("淺｜深", () => {
  const design = designOf(part("stack", "s", { items: [note("n-alpha", "alpha")] }));
  const scope = () => document.querySelector(".site-scope") as HTMLElement;
  const style = (patch: Partial<SiteDesignV2["style"]> = {}) => ({ ...defaultDesignV2({}).style, ...patch });
  const light = colorVars(style(), "light");
  const dark = colorVars(style(), "dark");

  it("the canvas wears the colours of the chosen side, from the same formula as the site", () => {
    const site = makeSite({ ...design, style: style({ scheme: "light" }) });
    mount(site);
    expect(scope().style.getPropertyValue("--s-bg")).toBe(light["--s-bg"]);
    expect(screen.getByRole("button", { name: "淺" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "深" }));
    expect(scope().style.getPropertyValue("--s-bg")).toBe(dark["--s-bg"]);
    expect(scope().style.getPropertyValue("--s-text")).toBe(dark["--s-text"]);
    expect(scope().dataset.scheme).toBe("dark");
    expect(scope().style.colorScheme).toBe("dark");
    expect(screen.getByRole("button", { name: "深" })).toHaveAttribute("aria-pressed", "true");
    expect(site.changeDesign).not.toHaveBeenCalled(); // a preview only, not in the design
    expect(site.setHome).not.toHaveBeenCalled();
  });
  it("starts from the site's 配色 setting: 深色 is dark, 跟隨系統 follows Onden's own theme", () => {
    const { unmount } = mount(makeSite({ ...design, style: style({ scheme: "dark" }) }));
    expect(scope().style.getPropertyValue("--s-bg")).toBe(dark["--s-bg"]);
    unmount();
    document.documentElement.setAttribute("data-theme", "dark");
    try {
      mount(makeSite({ ...design, style: style({ scheme: "system" }) }));
      expect(scope().style.getPropertyValue("--s-bg")).toBe(dark["--s-bg"]);
      cleanup();
      mount(makeSite({ ...design, style: style({ scheme: "light" }) }));
      expect(scope().style.getPropertyValue("--s-bg")).toBe(light["--s-bg"]);
    } finally { document.documentElement.removeAttribute("data-theme"); }
  });
  it("no white paper any more: the background is the design's own colour", () => {
    mount(makeSite({ ...design, style: style({ scheme: "light" }) }));
    expect(scope().style.getPropertyValue("--s-bg")).not.toBe("#ffffff");
    expect(scope().className).toContain("hs-paper");
  });
  it("changing the site's 配色 setting takes the preview back to that setting", () => {
    const first = makeSite({ ...design, style: style({ scheme: "light" }) });
    const { rerender } = mount(first);
    fireEvent.click(screen.getByRole("button", { name: "深" }));
    expect(scope().style.getPropertyValue("--s-bg")).toBe(dark["--s-bg"]);
    rerender(<HomeStudio site={makeSite({ ...design, style: style({ scheme: "dark" }) })} onOpenNode={vi.fn()} />);
    expect(scope().style.getPropertyValue("--s-bg")).toBe(dark["--s-bg"]);
    rerender(<HomeStudio site={makeSite({ ...design, style: style({ scheme: "light" }) })} onOpenNode={vi.fn()} />);
    expect(scope().style.getPropertyValue("--s-bg")).toBe(light["--s-bg"]);
  });
  it("the phone width draws the type at the phone's width", () => {
    mount(makeSite({ ...design, style: style({ scheme: "light" }) }));
    expect(scope().style.getPropertyValue("--s-base")).toMatch(/^clamp\(/);
    fireEvent.click(screen.getByRole("button", { name: "手機" }));
    expect(scope().style.getPropertyValue("--s-base")).toMatch(/^1[67]\.\d+px$|^1[67]px$/);
  });
});

describe("建議", () => {
  const design = designOf(part("stack", "s", { items: [note("n-draft", "draft")] }));
  const open = async (site: HomeStudioState) => {
    mount(site);
    fireEvent.click(screen.getByRole("tab", { name: /建議/ }));
    return screen.getByRole("tabpanel");
  };
  it("shows the unpublished note, and previewing changes nothing that is saved", async () => {
    const site = makeSite(design);
    const panel = await open(site);
    expect(within(panel).getByText(/Draft/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "預覽" }));
    // the canvas now shows the note as it would be once published, with the banner
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("預覽");
    await waitFor(() => expect((document.querySelector(".hs-canvas__frame") as HTMLElement).textContent).toContain("Secret draft words"));
    expect(site.applyDesign).not.toHaveBeenCalled();
    expect(site.changeDesign).not.toHaveBeenCalled();
    expect(site.setHome).not.toHaveBeenCalled();
    expect(site.publish.include).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect((document.querySelector(".hs-canvas__frame") as HTMLElement).textContent).not.toContain("Secret draft words");
  });
  it("一起發布 publishes the note together; nothing happens before it is pressed", async () => {
    setLocalePref("zh-TW");
    const site = makeSite(design);
    const panel = await open(site);
    fireEvent.click(within(panel).getByRole("button", { name: "一起發布" }));
    await waitFor(() => expect(site.publish.include).toHaveBeenCalledWith(["draft"]));
  });
  it("applying a design suggestion replaces the design; previewing it did not", async () => {
    const site = makeSite({ ...designOf(part("stack", "s", { items: [note("n", "alpha")] })), css: "a { color: red" });
    const panel = await open(site);
    fireEvent.click(within(panel).getByRole("button", { name: "預覽" }));
    expect(site.applyDesign).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "套用" }));
    await waitFor(() => expect(site.applyDesign).toHaveBeenCalledTimes(1));
    expect(vi.mocked(site.applyDesign).mock.calls[0]![0].css).toBe("a { color: red\n}");
  });
});

describe("區塊", () => {
  const aside = () => screen.getByRole("complementary", { name: "區塊" });
  // Only drawer entries: the outline on 版面配置 also names the blocks already on the page.
  const clickKind = (name: string) => fireEvent.click(within(aside()).getAllByText(name).find((el) => el.closest("[data-puck-drawer-item]"))!);
  const lastHome = (site: HomeStudioState) => vi.mocked(site.setHome).mock.calls.at(-1)![0];
  const openTab = (name: string) => fireEvent.click(within(aside()).getByRole("tab", { name }));
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    Element.prototype.scrollIntoView = vi.fn(); // Puck's outline scrolls the selected row into view; jsdom has no layout
  });

  it("lists kinds of block in two tabs, never a note or a tag", () => {
    mount(makeSite(designOf()));
    expect(within(aside()).getByRole("tab", { name: "零件" })).toHaveAttribute("aria-selected", "true");
    for (const title of ["內容", "文字與圖片"]) expect(within(aside()).getByRole("heading", { name: title })).toBeInTheDocument();
    expect(within(aside()).queryByRole("heading", { name: "排版" })).toBeNull();
    // Puck draws each drawer item twice (the item and the one that follows the pointer).
    for (const name of ["一篇筆記", "標籤的筆記", "最近的筆記", "時間軸", "筆記摘要", "圖文卡片", "只有標題"]) {
      expect(within(aside()).getAllByText(name).length, name).toBeGreaterThan(0);
    }
    openTab("版面配置");
    for (const title of ["頁面結構", "排版", "現成區塊"]) expect(within(aside()).getByRole("heading", { name: title })).toBeInTheDocument();
    expect(within(aside()).queryByRole("heading", { name: "內容" })).toBeNull();
    for (const name of ["堆疊", "卡片格", "介紹＋近況"]) expect(within(aside()).getAllByText(name).length, name).toBeGreaterThan(0);
    expect(within(aside()).queryAllByText("Alpha")).toHaveLength(0);
    expect(within(aside()).queryAllByText("Draft")).toHaveLength(0);
    expect(within(aside()).queryAllByText(/文章/)).toHaveLength(0);
    expect(within(aside()).queryByRole("button", { name: "從網站移除" })).toBeNull();
  });
  it("clicking 一篇筆記 inserts an empty note block (the note is chosen on the right)", async () => {
    const site = makeSite(designOf(part("stack", "s", { items: [] })));
    mount(site);
    clickKind("一篇筆記");
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    const home = lastHome(site);
    // the note goes on the top level as it is, with no stack around it
    expect(home.content.map((c) => c.type)).toEqual(["stack", "note"]);
    expect(home.content[1]).toMatchObject({ props: { noteId: "", display: "full" } });
  });
  it("the text and picture kinds are a note with that look", async () => {
    for (const [name, display] of [["筆記摘要", "first"], ["圖文卡片", "card"], ["只有標題", "title"]] as const) {
      const site = makeSite(designOf());
      const { unmount } = mount(site);
      clickKind(name);
      await waitFor(() => expect(site.setHome).toHaveBeenCalled());
      expect(lastHome(site).content[0], name).toMatchObject({ type: "note", props: { display } });
      unmount();
    }
  });
  it("最近的筆記 is a tag's list, newest five", async () => {
    const site = makeSite(designOf());
    mount(site);
    clickKind("最近的筆記");
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(lastHome(site).content[0]).toMatchObject({ type: "tag_view", props: { sort: "new", limit: 5, viewKind: "list" } });
  });
  it("inserts after the selected block", async () => {
    const site = makeSite(designOf(part("stack", "a", { items: [note("n1", "alpha")] }), part("stack", "b", { items: [note("n2", "alpha")] })));
    mount(site);
    await select("a");
    openTab("版面配置");
    clickKind("堆疊");
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(lastHome(site).content.map((c) => (c.props.id as string))).toHaveLength(3);
    expect(lastHome(site).content[0]!.props.id).toBe("a");
    expect(lastHome(site).content[2]!.props.id).toBe("b");
  });
  it("the search box narrows the kinds, and reads the sentence: 格子 finds 卡片格", () => {
    mount(makeSite(designOf()));
    fireEvent.change(within(aside()).getByLabelText(/^搜尋區塊/), { target: { value: "格子" } });
    expect(within(aside()).getAllByText("卡片格").length).toBeGreaterThan(0);
    expect(within(aside()).queryAllByText("堆疊")).toHaveLength(0);
    expect(within(aside()).getByRole("tablist", { name: "左欄" })).toBeInTheDocument();
    fireEvent.change(within(aside()).getByLabelText(/^搜尋區塊/), { target: { value: "沒有這種東西" } });
    expect(within(aside()).getByText("沒有符合的區塊。")).toBeInTheDocument();
  });
  it("searching from either tab lists both tabs' matches with their group, and clearing returns to the tab", () => {
    mount(makeSite(designOf()));
    const search = within(aside()).getByLabelText(/^搜尋區塊/);
    fireEvent.change(search, { target: { value: "筆記" } });
    expect(within(aside()).getAllByText("一篇筆記").length).toBeGreaterThan(0);
    expect(within(aside()).getAllByText("・零件").length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "" } });
    openTab("版面配置");
    fireEvent.change(search, { target: { value: "只有標題" } });
    expect(within(aside()).getAllByText("只有標題").length).toBeGreaterThan(0);
    expect(within(aside()).queryAllByText("堆疊")).toHaveLength(0);
    fireEvent.change(search, { target: { value: "" } });
    expect(within(aside()).getByRole("tab", { name: "版面配置" })).toHaveAttribute("aria-selected", "true");
    expect(within(aside()).getAllByText("堆疊").length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "筆記" } });
    openTab("零件");
    expect(search).toHaveValue("");
    expect(within(aside()).getByRole("tab", { name: "零件" })).toHaveAttribute("aria-selected", "true");
  });
  it("the layout tab shows 頁面結構 always open, and the tab is remembered and keyboard-operable", () => {
    const { unmount } = mount(makeSite(designOf(part("stack", "s", { items: [] }))));
    expect(within(aside()).queryByText("頁面上現有的東西，點一下就選取。")).toBeNull();
    const parts = within(aside()).getByRole("tab", { name: "零件" });
    parts.focus();
    fireEvent.keyDown(parts, { key: "ArrowRight" });
    expect(within(aside()).getByRole("tab", { name: "版面配置" })).toHaveAttribute("aria-selected", "true");
    expect(within(aside()).getByText("頁面上現有的東西，點一下就選取。")).toBeVisible();
    expect(localStorage.getItem(PREFS.siteStudioLeftTab.key)).toBe("layout");
    unmount();
    mount(makeSite(designOf()));
    expect(within(aside()).getByRole("tab", { name: "版面配置" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(within(aside()).getByRole("tab", { name: "版面配置" }), { key: "ArrowLeft" });
    expect(within(aside()).getByRole("tab", { name: "零件" })).toHaveAttribute("aria-selected", "true");
  });
  it("every part, template and the timeline has a sentence and a wireframe", () => {
    mount(makeSite(designOf()));
    const hasInfo = (type: string) => {
      const info = ASSET_INFO[type]!;
      expect(info.description, type).not.toBe("");
      expect(within(aside()).getAllByText(info.description).length, type).toBeGreaterThan(0);
      expect(aside().querySelectorAll(`[title="${info.description}"] svg.hs-wire`).length, type).toBeGreaterThan(0);
    };
    hasInfo("timeline");
    openTab("版面配置");
    for (const type of [...PART_TYPES, ...PATTERN_TYPES]) hasInfo(type);
  });
  it("plain titles, one hint at the top, and one 頁面結構 heading", () => {
    mount(makeSite(designOf()));
    for (const gone of ["區塊範本", "版面零件", "模組", "大綱", "筆記", "標籤", "動態內容"]) expect(within(aside()).queryByRole("heading", { name: gone })).toBeNull();
    openTab("版面配置");
    expect(within(aside()).getAllByText("頁面結構")).toHaveLength(1);
    expect(within(aside()).getAllByText("點一下加在選取的後面，或拖到右邊畫面。")).toHaveLength(1);
  });
});

describe("＋ and /", () => {
  const design = designOf(part("stack", "s", { items: [note("n-alpha", "alpha")] }));
  it("a selected block has a ＋ that is on screen without hovering; it opens the same kinds and inserts after the block", async () => {
    const site = makeSite(design);
    mount(site);
    expect(screen.queryByRole("button", { name: "Add a block after this one" })).toBeNull();
    await select("n-alpha");
    const plus = await screen.findByRole("button", { name: "Add a block after this one" });
    expect(plus).toBeVisible();
    fireEvent.click(plus);
    const menu = screen.getByRole("dialog", { name: "Add a block" });
    expect(within(menu).getByText("Add after the selected block")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: /筆記摘要/ }));
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    const items = vi.mocked(site.setHome).mock.calls.at(-1)![0].content.flatMap((c) => (c.props.items as PuckComponentData[] | undefined) ?? []);
    expect(items.map((c) => c.type)).toEqual(["note", "note"]);
    expect(items[1]!.props).toMatchObject({ display: "first" });
    expect(screen.queryByRole("dialog", { name: "Add a block" })).toBeNull();
  });
  it("/ opens the menu from anywhere on the page but not while typing; Enter takes the first match", async () => {
    const site = makeSite(designOf());
    mount(site);
    const search = screen.getByLabelText(/^搜尋區塊/);
    fireEvent.keyDown(search, { key: "/" });
    expect(screen.queryByRole("dialog", { name: "Add a block" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    const menu = await screen.findByRole("dialog", { name: "Add a block" });
    expect(within(menu).getByText("Add at the end of the page")).toBeInTheDocument();
    fireEvent.change(within(menu).getByPlaceholderText("Search blocks…"), { target: { value: "只有標題" } });
    fireEvent.keyDown(within(menu).getByPlaceholderText("Search blocks…"), { key: "Enter" });
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(vi.mocked(site.setHome).mock.calls.at(-1)![0].content[0]).toMatchObject({ type: "note", props: { display: "title" } });
  });
  it("Escape closes the menu", () => {
    mount(makeSite(designOf()));
    fireEvent.keyDown(document.body, { key: "/" });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add a block" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add a block" })).toBeNull();
  });
});

/** Select a component the way a click on the canvas does. */
async function select(componentId: string) {
  const el = await waitFor(() => { const found = document.querySelector(`[data-puck-component="${componentId}"]`); expect(found).not.toBeNull(); return found as HTMLElement; });
  fireEvent.click(el);
  return screen.findByRole("tabpanel");
}

describe("屬性", () => {
  // "Quoted words" is the anchor p1 on the device (the text carries no id).
  const alphaMarkdown = holdAnchored("alpha", "# Alpha\n\nFirst words.\n\nQuoted words ^p1\n");
  const withBlocks = () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...nodes[0]!, markdown: alphaMarkdown }, nodes[1]!], tags: [tagA] }, online: true });
  };
  const design = designOf(part("stack", "s", { items: [note("n-alpha", "alpha"), { type: "tag_view", props: { id: "tv", tagId: "tA", viewId: "", viewKind: "list", limit: 6, sort: "new" } }] }));

  it("a note shows its words read-only, with 「到筆記裡改」", async () => {
    withBlocks();
    const onOpenNode = vi.fn();
    mount(makeSite(design), onOpenNode);
    const panel = await select("n-alpha");
    expect(within(panel).getByText("Alpha", { selector: ".hs-field__current" })).toBeInTheDocument();
    expect(within(panel).getByLabelText("筆記內容（唯讀）")).toHaveTextContent("First words.");
    fireEvent.click(within(panel).getByRole("button", { name: "到筆記裡改" }));
    expect(onOpenNode).toHaveBeenCalledWith("alpha");
    expect(within(panel).queryByRole("textbox", { name: /內容|內文/ })).toBeNull();
  });
  it("choosing another note changes the component", async () => {
    withBlocks();
    const site = makeSite(design);
    mount(site);
    const panel = await select("n-alpha");
    fireEvent.click(within(panel).getByRole("button", { name: /Draft/ }));
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    const home = vi.mocked(site.setHome).mock.calls.at(-1)![0];
    expect(((home.content[0]!.props.items as PuckComponentData[])[0]!.props.noteId)).toBe("draft");
  });
  it("the note picker: filter 全部／已發布 N／未發布 N, rows with title, date and a mark", async () => {
    setLocalePref("zh-TW");
    withBlocks();
    mount(makeSite(design));
    const panel = await select("n-alpha");
    const filters = within(within(panel).getByRole("radiogroup", { name: "篩選筆記" }));
    expect(filters.getAllByRole("radio").map((b) => b.textContent)).toEqual(["全部", "已發布 1", "未發布 1"]);
    const list = within(panel).getAllByRole("listitem");
    const alpha = list.find((li) => li.textContent?.includes("Alpha"))!;
    expect(within(alpha).getByText("已發布")).toBeInTheDocument();
    expect(alpha.querySelector("time")).toHaveTextContent("2026-03-02");
    const draft = list.find((li) => li.textContent?.includes("Draft"))!;
    expect(within(draft).getByText("未發布")).toBeInTheDocument();
    fireEvent.click(filters.getByRole("radio", { name: "未發布 1" }));
    expect(within(panel).queryByRole("button", { name: /^Alpha/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: /Draft/ })).toBeInTheDocument();
    fireEvent.click(filters.getByRole("radio", { name: "已發布 1" }));
    expect(within(panel).queryByRole("button", { name: /Draft/ })).toBeNull();
    fireEvent.click(filters.getByRole("radio", { name: "全部" }));
    const search = within(panel).getAllByRole("searchbox")[0]!;
    fireEvent.change(search, { target: { value: "dra" } });
    expect(within(panel).queryByRole("button", { name: /^Alpha/ })).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(panel).getByText("沒有符合的筆記")).toBeInTheDocument();
  });
  it("an unpublished note offers 「發布這篇」, which marks that note published", async () => {
    withBlocks();
    const site = makeSite(designOf(part("stack", "s", { items: [note("n-draft", "draft")] })));
    mount(site);
    const panel = await select("n-draft");
    expect(within(panel).queryByRole("button", { name: "從網站移除" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "發布這篇" }));
    expect(site.publishNote).toHaveBeenCalledWith("draft");
    expect(site.setHome).not.toHaveBeenCalled();
  });
  it("a published note has no 「發布這篇」; it can be taken off the site (never deleted)", async () => {
    withBlocks();
    const site = makeSite(design);
    mount(site);
    const panel = await select("n-alpha");
    expect(within(panel).queryByRole("button", { name: "發布這篇" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "從網站移除" }));
    expect(site.unpublishNote).toHaveBeenCalledWith("alpha");
  });
  it("顯示方式: 整篇／摘要／只有標題, an old block counts as 整篇", async () => {
    withBlocks();
    const site = makeSite(design);
    mount(site);
    const panel = await select("n-alpha");
    const group = within(within(panel).getByRole("radiogroup", { name: "顯示方式" }));
    expect(group.getAllByRole("radio").map((b) => b.textContent)).toEqual(["整篇", "摘要", "只有標題"]);
    expect(group.getByRole("radio", { name: "整篇" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(group.getByRole("radio", { name: "只有標題" }));
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(((vi.mocked(site.setHome).mock.calls.at(-1)![0].content[0]!.props.items as PuckComponentData[])[0]!.props.display)).toBe("title");
  });
  it("the settings are shown only while nothing is selected", async () => {
    withBlocks();
    mount(makeSite(design));
    expect(screen.getByLabelText("網站名稱")).toBeInTheDocument();
    const panel = await select("n-alpha");
    expect(within(panel).queryByLabelText("網站名稱")).toBeNull();
  });
  it("the paragraph picker lists the note's anchored paragraphs, only when the note has any", async () => {
    withBlocks();
    const site = makeSite(design);
    mount(site);
    let panel = await select("n-alpha");
    fireEvent.click(within(panel).getByRole("button", { name: /Quoted words/ }));
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(((vi.mocked(site.setHome).mock.calls.at(-1)![0].content[0]!.props.items as PuckComponentData[])[0]!.props.blockId)).toBe("p1");
    cleanup();
    // a note without any anchor offers none
    const plain = designOf(part("stack", "s", { items: [note("n-draft", "draft")] }));
    mount(makeSite(plain));
    panel = await select("n-draft");
    expect(within(panel).queryByText("只放其中一段")).toBeNull();
  });
  it("a tag view picks its tag and one of that tag's saved views (storing the view and its kind)", async () => {
    withBlocks();
    viewsList.mockResolvedValue({ views: [{ id: "v1", name: "Gallery", layout: "gallery" }, { id: "v2", name: "Grid", layout: "table" }] });
    const site = makeSite(design);
    mount(site);
    const panel = await select("tv");
    expect(within(panel).getByText("文章", { selector: ".hs-field__current" })).toBeInTheDocument();
    const picker = await within(panel).findByLabelText("檢視");
    fireEvent.change(picker, { target: { value: "v1" } });
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    const props = (vi.mocked(site.setHome).mock.calls.at(-1)![0].content[0]!.props.items as PuckComponentData[])[1]!.props;
    expect(props).toMatchObject({ viewId: "v1", viewKind: "cards" });
    expect(viewsList).toHaveBeenCalledWith({ kind: "tag", id: "tA" });
  });
  it("a part's settings come with a collapsed 「進階」 for its class name and CSS", async () => {
    withBlocks();
    const site = makeSite(design);
    mount(site);
    const panel = await select("s");
    const advanced = within(panel).getByText("進階").closest("details") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    fireEvent.change(within(advanced).getByLabelText("class 名稱"), { target: { value: "wide" } });
    fireEvent.change(within(advanced).getByLabelText("只作用在這個零件的 CSS"), { target: { value: "& p { color: red }" } });
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    expect(vi.mocked(site.setHome).mock.calls.at(-1)![0].content[0]!.props).toMatchObject({ cls: "wide", css: "& p { color: red }" });
  });
  it("a template offers 「展開成零件」, which keeps the page the same", async () => {
    withBlocks();
    const site = makeSite(designOf({ type: "pattern_work_cards", props: { id: "p", bg: "none", heading: "auto", cls: "", css: "", items: [{ type: "tag_view", props: { id: "pv", tagId: "tA", viewId: "", viewKind: "cards", limit: 6, sort: "new" } }] } }));
    mount(site);
    const panel = await select("p");
    fireEvent.click(within(panel).getByRole("button", { name: "展開成零件" }));
    await waitFor(() => expect(site.setHome).toHaveBeenCalled());
    const home = vi.mocked(site.setHome).mock.calls.at(-1)![0];
    expect(home.content[0]).toMatchObject({ type: "stack", props: { id: "p" } });
    expect((home.content[0]!.props.items as PuckComponentData[])[0]!.props.id).toBe("pv");
  });
  it("every input in the panel has a real label tied to it", async () => {
    withBlocks();
    mount(makeSite(design));
    const panel = await select("tv");
    await within(panel).findByText("文章", { selector: ".hs-field__current" });
    for (const control of panel.querySelectorAll("input, select, textarea")) {
      const labelled = (control.id && panel.querySelector(`label[for="${control.id}"]`)) || control.closest("label");
      expect(labelled, control.outerHTML).toBeTruthy();
    }
  });
});

describe("toolbar", () => {
  it("publishing is not offered offline, and the toolbar stays one row", () => {
    mount(makeSite(designOf(), { online: false }));
    expect(screen.getByRole("button", { name: "發布" })).toBeDisabled();
    const css = document.querySelector(".hs-toolbar");
    expect(css).not.toBeNull();
  });
  it("shows whether the design is saved on the server, saved on this device, or not saved", () => {
    const { rerender } = mount(makeSite(designOf(), { save: { status: "synced", retry: vi.fn() } as never }));
    expect(screen.getByRole("status")).toHaveTextContent("Website changes saved");
    rerender(<HomeStudio site={makeSite(designOf(), { save: { status: "queued", retry: vi.fn() } as never })} onOpenNode={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Website changes saved locally");
    const retry = vi.fn();
    rerender(<HomeStudio site={makeSite(designOf(), { save: { status: "error", retry } as never })} onOpenNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    expect(retry).toHaveBeenCalled();
  });
});
void act;
