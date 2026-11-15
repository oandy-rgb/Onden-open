import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NO_FACTS, defaultBoxes, picksOf, type WidgetFacts } from "@onden/site";
import { setLocalePref } from "../../../lib/i18n";
import ReplacePicker from "./ReplacePicker";
import type { BoxTarget } from "./boxEdit";

beforeEach(() => setLocalePref("zh-TW"));
afterEach(() => { cleanup(); setLocalePref("system"); });

const boxes = defaultBoxes();
const facts: WidgetFacts = { ...NO_FACTS, introNote: true, articles: 5, topics: 2, featured: 0 };

function setup(target: BoxTarget, over: { facts?: WidgetFacts } = {}) {
  const onPreview = vi.fn(); const onApply = vi.fn(); const onBoxes = vi.fn(); const onClose = vi.fn();
  render(<ReplacePicker target={target} boxes={boxes} facts={over.facts ?? facts} onPreview={onPreview} onApply={onApply} onBoxes={onBoxes} onClose={onClose} />);
  return { onPreview, onApply, onBoxes, onClose, last: () => onPreview.mock.calls.at(-1)?.[0] };
}
const option = (widget: string) => document.querySelector<HTMLElement>(`[data-widget="${widget}"]`)!;

describe("換成…", () => {
  it("lists only the widgets this box takes, with 留空 for a single box", () => {
    setup({ box: "note.left", index: 0 });
    const names = [...document.querySelectorAll(".ss-option__name")].map((e) => e.textContent);
    expect(names).toEqual(["留空", "目錄", "側註", "檔案樹"]);
  });

  it("a list slot has no 留空 but moves and removes", () => {
    const { onBoxes } = setup({ box: "home.list", index: 1 });
    expect(screen.queryByText("留空")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "上移" }));
    expect(picksOf(onBoxes.mock.calls[0]![0], "home.list").map((p) => p.widget)).toEqual(["topics", "recent", "all"]);
  });

  it("resting the pointer on an option shows it in the slot at once; leaving takes it back; nothing is applied", () => {
    const { onPreview, onApply, last } = setup({ box: "home.list", index: 0 });
    expect(last()).toBeUndefined();
    fireEvent.mouseEnter(option("featured"));
    expect(last()).toEqual({ widget: "featured", variant: "list" });
    fireEvent.mouseLeave(option("featured"));
    expect(last()).toBeUndefined();
    fireEvent.mouseEnter(option("all"));
    expect(last()).toEqual({ widget: "all", variant: "byYear" });
    expect(onApply).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalled();
  });

  it("a tap keeps the preview (a phone has no hover); only 套用 replaces", () => {
    const { onApply, last } = setup({ box: "home.list", index: 0 });
    expect(screen.getByRole("button", { name: "套用" })).toBeDisabled();
    fireEvent.click(option("topics"));
    fireEvent.mouseLeave(option("topics"));
    expect(last()).toEqual({ widget: "topics", variant: "list" });
    fireEvent.click(screen.getByRole("button", { name: "套用" }));
    expect(onApply).toHaveBeenCalledWith({ widget: "topics", variant: "list" });
  });

  it("the chosen widget's looks are listed; one is previewed on hover and applied on 套用", () => {
    const { onApply, last } = setup({ box: "home.list", index: 2 }); // all / byYear
    const row = option("all").closest("li")!;
    const variants = within(row).getAllByRole("button").filter((b) => b.classList.contains("ss-variant"));
    expect(variants.map((b) => b.textContent)).toEqual(["依年份", "最近 10 篇", "標上成熟度"]);
    fireEvent.mouseEnter(variants[2]!);
    expect(last()).toEqual({ widget: "all", variant: "maturity" });
    fireEvent.click(variants[2]!);
    fireEvent.mouseLeave(variants[2]!);
    fireEvent.click(screen.getByRole("button", { name: "套用" }));
    expect(onApply).toHaveBeenCalledWith({ widget: "all", variant: "maturity" });
  });

  it("留空 empties a single box, only on 套用", () => {
    const { onApply } = setup({ box: "note.left", index: 0 });
    fireEvent.click(screen.getByText("留空"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "套用" }));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("a widget that has no data yet says what it needs", () => {
    setup({ box: "home.list", index: 0 });
    expect(within(option("featured")).getByText("需要標了「精選」的已發布筆記")).toBeInTheDocument();
    expect(within(option("topics")).queryByText(/需要/)).toBeNull();
  });

  it("the 加一格 slot of a list box offers the box's widgets and no move or remove", () => {
    setup({ box: "home.list", index: 3 });
    expect(screen.getByText(/加到/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
  });

  it("取消 closes without applying", () => {
    const { onApply, onClose } = setup({ box: "home.list", index: 0 });
    fireEvent.click(option("topics"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
