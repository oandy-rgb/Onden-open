import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { defaultDesign, picksOf, type SiteBoxes } from "@onden/site";
import { setLocalePref } from "../../../lib/i18n";
import { readSiteData, siteFacts } from "../../../components/siteFrame";
import SetupCanvas from "./SetupCanvas";

beforeAll(async () => { await loadAllEnhancers(); });
beforeEach(() => setLocalePref("zh-TW"));
afterEach(() => { cleanup(); setLocalePref("system"); });

const note = (id: string, title: string, md: string, tags: string[] = []) =>
  ({ id, node_type: "content" as const, title, slug: id, markdown: md, tags, created_at: "2026-02-03T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" });
const design = defaultDesign();
const data = readSiteData({
  title: "花園", home_node_id: "home",
  payload: {
    nodes: [note("home", "首頁", "# 首頁\n\n你好，我在這裡。"), note("a", "堆肥", "# 堆肥\n\n落葉。", ["精選"]), note("b", "播種", "# 播種\n\n春天。")],
    edges: [], presentation: { site: { brand: "花園" }, design: { ...design, resolved: {}, tag_pages: {}, tag_names: {} } },
  },
});

function setup(over: { readerOnly?: boolean } = {}) {
  const onBoxes = vi.fn<(boxes: SiteBoxes) => void>();
  render(<SetupCanvas data={data} design={design} page={{ kind: "home" }} width={null} facts={siteFacts(data)} readerOnly={over.readerOnly ?? false} onBoxes={onBoxes} />);
  return onBoxes;
}
const slot = (box: string, index: number) => document.querySelector<HTMLElement>(`.ss-frame [data-box="${box}"][data-index="${index}"]`)!;

describe("the website screen's page", () => {
  it("a click on a slot opens 換成… with only what that box takes", async () => {
    setup();
    fireEvent.click(slot("home.list", 0));
    expect(await screen.findByTestId("replace-picker")).toBeInTheDocument();
    expect([...document.querySelectorAll("[data-widget].ss-option")].map((e) => e.getAttribute("data-widget"))).toEqual(
      ["intro", "latest", "recent", "all", "topics", "featured", "subscribe"]);
  });

  it("pointing at an option draws it in the slot; 套用 is the only thing that changes the design", async () => {
    const onBoxes = setup();
    expect(slot("home.list", 0).getAttribute("data-widget")).toBe("recent");
    fireEvent.click(slot("home.list", 0));
    const option = (await screen.findByTestId("replace-picker")).querySelector<HTMLElement>('[data-widget="latest"]')!;
    fireEvent.mouseEnter(option);
    expect(slot("home.list", 0).getAttribute("data-widget")).toBe("latest");
    expect(onBoxes).not.toHaveBeenCalled();
    fireEvent.mouseLeave(option);
    expect(slot("home.list", 0).getAttribute("data-widget")).toBe("recent");
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "套用" }));
    expect(onBoxes).toHaveBeenCalledOnce();
    expect(picksOf(onBoxes.mock.calls[0]![0], "home.list")[0]).toEqual({ widget: "latest", variant: "card" });
    expect(screen.queryByTestId("replace-picker")).toBeNull();
  });

  it("＋加一格 opens the picker for a new slot; a widget with no data shows what it needs", async () => {
    const onBoxes = setup();
    fireEvent.click(document.querySelector('[data-add][data-box="home.list"]')!);
    const picker = await screen.findByTestId("replace-picker");
    const featured = picker.querySelector<HTMLElement>('[data-widget="featured"]')!;
    fireEvent.click(featured);
    fireEvent.click(screen.getByRole("button", { name: "套用" }));
    expect(picksOf(onBoxes.mock.calls[0]![0], "home.list")).toHaveLength(4);
  });

  it("only-what-readers-see: no markers, no add button, clicks open nothing", () => {
    setup({ readerOnly: true });
    expect(document.querySelector(".s-w--add")).toBeNull();
    expect(document.querySelector(".ss-frame[data-edit]")).toBeNull();
    fireEvent.click(slot("home.list", 0));
    expect(screen.queryByTestId("replace-picker")).toBeNull();
  });

  it("a link in the page does not leave the screen", () => {
    setup();
    const link = document.querySelector<HTMLAnchorElement>(".ss-frame a[href]")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("a link does not leave the screen in 「only what readers see」 either", () => {
    setup({ readerOnly: true });
    const link = document.querySelector<HTMLAnchorElement>(".ss-frame a[href]")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("replace-picker")).toBeNull();
  });

  it("the reader's theme switch is a button in the page, in both views", () => {
    for (const readerOnly of [false, true]) {
      cleanup();
      setup({ readerOnly });
      expect(document.querySelector(".ss-frame [data-s-scheme]")).not.toBeNull();
    }
  });
});
