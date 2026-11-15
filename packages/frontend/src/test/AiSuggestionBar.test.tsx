import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiSuggestionBar } from "../components/AiSuggestionBar";
import { setLocalePref } from "../lib/i18n";
import type { OffPlace, Place, SuggestionLayout } from "../lib/aiSuggestions";

const place = (itemId: string, at: number): Place => ({
  itemId, suggestionId: "s1", kind: "replace", from: 0, to: at, at, newText: "x", spacingOnly: false, agentName: "我的 Claude", older: false, busy: false, canAct: true,
});
const off = (extra: Partial<OffPlace>): OffPlace => ({ itemId: "o1", suggestionId: "s1", kind: "title", text: "新標題", agentName: "我的 Claude", older: false, state: "open", ...extra });
const layout = (extra: Partial<SuggestionLayout> = {}): SuggestionLayout => ({ places: [place("i1", 5), place("i2", 20)], off: [], total: 2, actionable: 2, skills: [], ...extra });
function bar(props: Partial<Parameters<typeof AiSuggestionBar>[0]> = {}) {
  const handlers = { onDecideAll: vi.fn(), onDecideRow: vi.fn(), decide: vi.fn(async () => true), onStep: vi.fn() };
  render(<AiSuggestionBar layout={layout()} markdown="" canDecide online busy={false} {...handlers} {...props} />);
  return handlers;
}

beforeEach(() => setLocalePref("zh-TW"));
afterEach(cleanup);

describe("the bar above a note with AI suggestions", () => {
  it("says how many, accepts or rejects them all, steps through the places", () => {
    const h = bar();
    expect(screen.getByText("這篇有 2 處 AI 建議")).toBeTruthy();
    fireEvent.click(screen.getByText("全部接受"));
    fireEvent.click(screen.getByText("全部退回"));
    fireEvent.click(screen.getByText("下一處"));
    fireEvent.click(screen.getByText("上一處"));
    expect(h.onDecideAll.mock.calls).toEqual([["accept"], ["reject"]]);
    expect(h.onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("is absent when there is nothing to decide", () => {
    bar({ layout: layout({ places: [], total: 0, actionable: 0 }) });
    expect(screen.queryByText(/AI 建議/)).toBeNull();
  });

  it("lists the title and a changed place in the bar; a changed place can only be dismissed", () => {
    const h = bar({ layout: layout({ places: [], total: 2, off: [off({}), off({ itemId: "o2", kind: "replace", state: "changed", text: "" })] }) });
    expect(screen.getByText("建議把標題改成：新標題")).toBeTruthy();
    expect(screen.getByText("你已經改過這一段，這項建議無法套用。")).toBeTruthy();
    fireEvent.click(screen.getByText("略過"));
    expect(h.onDecideRow).toHaveBeenCalledWith(expect.objectContaining({ itemId: "o2" }), "reject");
    fireEvent.click(screen.getAllByText("接受")[0]!);
    expect(h.onDecideRow).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "o1" }), "accept");
  });

  it("offline or busy: the buttons wait, and offline says why", () => {
    bar({ online: false });
    const accept = screen.getByText("全部接受") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.title).toBe("接受或退回需要連線。");
    cleanup();
    bar({ busy: true });
    expect((screen.getByText("全部退回") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a person who only reads sees the list without buttons", () => {
    bar({ canDecide: false, layout: layout({ places: [], total: 1, off: [off({})] }) });
    expect(screen.getByText("建議把標題改成：新標題")).toBeTruthy();
    expect(screen.queryByText("全部接受")).toBeNull();
    expect(screen.queryByText("接受")).toBeNull();
  });
});

describe("the skill behind the suggestions", () => {
  it("says which skill the person named, or the AI picked itself with its reason — never an id", () => {
    bar({ layout: layout({ skills: [{ name: "論文摘要", picked: false, reason: null }] }) });
    expect(screen.getByText("AI 建議 · 用了「論文摘要」")).toBeTruthy();
    cleanup();
    bar({ layout: layout({ skills: [{ name: "出考題", picked: true, reason: "你在準備期中" }] }) });
    expect(screen.getByText("AI 建議 · 自己挑了「出考題」")).toBeTruthy();
    expect(screen.getByText("你在準備期中")).toBeTruthy();
  });
});
