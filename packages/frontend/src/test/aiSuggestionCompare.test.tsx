import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AiSuggestionCompareToggle from "../components/AiSuggestionCompare";
import { decidePlaces, suggestionCompare } from "../lib/aiSuggestionCompare";
import { layoutSuggestions, type Place } from "../lib/aiSuggestions";
import type { NoteSuggestion, SuggestionItem } from "@onden/contract";
import { setLocalePref } from "../lib/i18n";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}) } as DOMRect;
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect;

const NOTE = "# 計畫\n\n第一段\n\n第二段\n\n第三段\n\n第四段\n";
const item = (id: string, over: Partial<SuggestionItem>): SuggestionItem => ({
  id, seq: 1, kind: "replace", base_text: "", base_occurrence: 0, new_text: null, status: "pending", ...over,
});
function placesOf(items: SuggestionItem[], markdown = NOTE): Place[] {
  const suggestion: NoteSuggestion = { id: "s1", agent_actor_id: "a", agent_name: "我的 Claude", session_id: null, created_at: "2026-11-01", older: false, skill: null, items };
  return layoutSuggestions({ suggestions: [suggestion], can_decide: true }, { markdown, canEdit: true, online: true, busy: new Set() }).places;
}

beforeEach(() => setLocalePref("zh-TW"));
afterEach(cleanup);

describe("suggestionCompare: the note with the suggestions made", () => {
  it("a replace, a delete and an insert land where the server puts them", () => {
    const places = placesOf([
      item("r", { kind: "replace", base_text: "第一段", new_text: "第一段改寫" }),
      item("d", { kind: "delete", base_text: "第二段" }),
      item("i", { kind: "insert", base_text: "第三段", new_text: "新的一段" }),
    ]);
    const { after, places: cut } = suggestionCompare(NOTE, places);
    expect(after).toBe("# 計畫\n\n第一段改寫\n\n第三段\n\n新的一段\n\n第四段\n");
    expect(cut).toHaveLength(3);
    // The cut is exact: each place's ranges hold just its own change.
    const [r, d, i] = cut;
    expect(NOTE.slice(r!.before.from, r!.before.to)).toBe("第一段");
    expect(after.slice(r!.after.from, r!.after.to)).toBe("第一段改寫");
    expect(NOTE.slice(d!.before.from, d!.before.to)).toBe("第二段\n\n");
    expect(d!.after.from).toBe(d!.after.to);
    expect(after.slice(i!.after.from, i!.after.to)).toBe("\n\n新的一段");
    expect(cut.map((c) => c.owners.map((o) => o.itemId))).toEqual([["r"], ["d"], ["i"]]);
  });

  it("a comment changes no text; an insert at the very start goes first", () => {
    const places = placesOf([
      item("c", { kind: "comment", base_text: "第二段", new_text: "這裡可以更精簡" }),
      item("s", { kind: "insert", base_text: "", new_text: "前言" }),
    ]);
    const { after, places: cut } = suggestionCompare(NOTE, places);
    expect(after).toBe(`前言\n\n${NOTE}`);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.owners[0]!.itemId).toBe("s");
  });

  it("two suggestions on one paragraph are one place that decides both", () => {
    const places = placesOf([
      item("a", { kind: "replace", base_text: "第二段", new_text: "甲" }),
      item("b", { kind: "replace", base_text: "第二段", new_text: "乙" }),
    ]);
    const { places: cut } = suggestionCompare(NOTE, places);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.owners.map((o) => o.itemId).sort()).toEqual(["a", "b"]);
  });
});

describe("the AI suggestion compare view", () => {
  const items = [
    item("r", { kind: "replace", base_text: "第二段", new_text: "第二段改寫" }),
    item("i", { kind: "insert", base_text: "第四段", new_text: "收尾" }),
  ];
  const draw = (over: Partial<Parameters<typeof AiSuggestionCompareToggle>[0]> = {}) => {
    const onDecide = vi.fn(async (..._args: unknown[]) => true);
    const view = render(<AiSuggestionCompareToggle markdown={NOTE} places={placesOf(items)} canAct busy={false} decide={onDecide} {...over} />);
    fireEvent.click(screen.getByText("比較修改"));
    return { onDecide, ...view };
  };

  it("pressing accept on a place asks for that one suggestion and changes nothing on screen by itself", async () => {
    const { onDecide, container } = draw();
    await screen.findByText("第 1 處，共 2 處");
    const shown = container.querySelector(".cm-content")!.textContent;
    fireEvent.click(screen.getByText("接受"));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]).toEqual(["s1", ["r"], "accept"]);
    // Still the same text, still two places: only the server's answer (a new list) changes this view.
    expect(container.querySelector(".cm-content")!.textContent).toBe(shown);
    expect(screen.getByText("第 1 處，共 2 處")).toBeTruthy();
  });

  it("reject asks for the second place after stepping to it", async () => {
    const { onDecide } = draw();
    await screen.findByText("第 1 處，共 2 處");
    fireEvent.click(screen.getByLabelText("下一處"));
    await screen.findByText("第 2 處，共 2 處");
    fireEvent.click(screen.getByText("退回"));
    expect(onDecide.mock.calls[0]).toEqual(["s1", ["i"], "reject"]);
  });

  it("while a decision is on its way, or offline, the buttons wait", async () => {
    const waiting = draw({ busy: true });
    await screen.findByText("第 1 處，共 2 處");
    expect((screen.getByText("接受") as HTMLButtonElement).disabled).toBe(true);
    waiting.unmount();
    draw({ canAct: false, offlineReason: "接受或退回需要連線。" });
    await screen.findByText("第 1 處，共 2 處");
    expect((screen.getByText("退回") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("neighbouring suggestions are decided one by one", () => {
  // A rewrite of paragraph 1 and a delete of paragraph 2 touch, so the view draws them as one block.
  const adjacent = [
    item("r", { kind: "replace", base_text: "第一段", new_text: "第一段改寫" }),
    item("d", { kind: "delete", base_text: "第二段" }),
  ];
  it("each suggestion in a merged block has its own accept, and pressing one decides only that one", async () => {
    const onDecide = vi.fn(async (..._args: unknown[]) => true);
    render(<AiSuggestionCompareToggle markdown={NOTE} places={placesOf(adjacent)} canAct busy={false} decide={onDecide} />);
    fireEvent.click(screen.getByText("比較修改"));
    await screen.findByText(/第 1 處/);
    const accepts = screen.getAllByText("接受");
    expect(accepts).toHaveLength(2);
    fireEvent.click(accepts[1]!);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]).toEqual(["s1", ["d"], "accept"]);
  });

  it("two suggestions on the same paragraph are listed separately too", async () => {
    const onDecide = vi.fn(async (..._args: unknown[]) => true);
    const same = [
      item("a", { kind: "replace", base_text: "第二段", new_text: "甲" }),
      item("b", { kind: "replace", base_text: "第二段", new_text: "乙" }),
    ];
    render(<AiSuggestionCompareToggle markdown={NOTE} places={placesOf(same)} canAct busy={false} decide={onDecide} />);
    fireEvent.click(screen.getByText("比較修改"));
    await screen.findByText(/第 1 處/);
    const rejects = screen.getAllByText("退回");
    expect(rejects).toHaveLength(2);
    fireEvent.click(rejects[0]!);
    expect(onDecide.mock.calls).toHaveLength(1);
    expect(onDecide.mock.calls[0]![1]).toHaveLength(1);
  });
});

describe("decidePlaces", () => {
  it("one request per suggestion, in turn; the first refusal stops the rest and nothing is reported done", async () => {
    const place = (itemId: string, suggestionId: string) => ({ itemId, suggestionId }) as Place;
    const all = [place("a", "s1"), place("b", "s2"), place("c", "s1")];
    const ok = vi.fn(async (..._a: unknown[]) => true);
    await decidePlaces(all, "accept", ok);
    expect(ok.mock.calls).toEqual([["s1", ["a", "c"], "accept"], ["s2", ["b"], "accept"]]);
    const refused = vi.fn(async (..._a: unknown[]) => false);
    await decidePlaces(all, "accept", refused);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("a place that only changes the spacing", () => {
  const md = "- 甲\n\n- 乙\n\n結尾\n";
  const spacing = () => placesOf([item("sp", { kind: "replace", base_text: "- 甲", new_text: "- 甲", change: "spacing" })], md);

  it("is not drawn as two equal blocks: no edit in the text, listed on its own", () => {
    const compare = suggestionCompare(md, spacing());
    expect(compare.places).toEqual([]);
    expect(compare.after).toBe(md);
    expect(compare.spacingOnly.map((p) => p.itemId)).toEqual(["sp"]);
  });

  it("says so in words, with the paragraph, and its buttons decide it", async () => {
    const decide = vi.fn(async () => true);
    render(<AiSuggestionCompareToggle markdown={md} places={spacing()} canAct busy={false} decide={decide} />);
    fireEvent.click(screen.getByText("比較修改"));
    expect(screen.getByText(/只改了這一段前後的間距/)).toBeInTheDocument();
    expect(screen.queryByText("沒有差異。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("s1", ["sp"], "accept"));
  });

  it("a change of indentation only is told apart in the layout", () => {
    const code = "```py\nx\n    y\n```";
    const [place] = placesOf([item("in", { kind: "replace", base_text: code, new_text: "```py\nx\n  y\n```", change: "indent" })], `${code}\n`);
    expect(place).toMatchObject({ spacingOnly: false, indentOnly: true });
  });
});
