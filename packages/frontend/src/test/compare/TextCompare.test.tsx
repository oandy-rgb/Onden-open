import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TextCompareView, { compareChanges } from "../../components/compare/TextCompareView";
import { placeTouches, type ComparePlace } from "../../components/compare/comparePlaces";
import { setLocalePref } from "../../lib/i18n";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}) } as DOMRect;
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect;

beforeEach(() => setLocalePref("zh-TW"));
afterEach(cleanup);

const BEFORE = "# 標題\n\n第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段\n\n第六段\n\n第七段";
const AFTER = BEFORE.replace("第二段", "第二段改了").replace("第七段", "第七段也改了");

describe("compareChanges", () => {
  it("takes the caller's places as they are, without a diff of its own", () => {
    const { changes, tooLong } = compareChanges("abc", "abXc", [{ before: { from: 1, to: 1 }, after: { from: 1, to: 2 } }]);
    expect(tooLong).toBe(false);
    expect(changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual([[1, 1, 1, 2]]);
  });
  it("finds the places itself otherwise", () => {
    expect(compareChanges(BEFORE, AFTER).changes.length).toBeGreaterThan(0);
    expect(compareChanges("same", "same").changes).toEqual([]);
  });
  it("reports a diff that ran into its time limit", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `line ${i % 97} ${i}`).join("\n");
    const b = Array.from({ length: 4000 }, (_, i) => `row ${(i * 7) % 89} ${i}`).join("\n");
    expect(compareChanges(a, b, undefined, 1).tooLong).toBe(true);
  });
});

describe("TextCompareView", () => {
  const props = { before: BEFORE, after: AFTER, beforeLabel: "當時", afterLabel: "現在" };

  it("side by side: two editors, read only, with the two labels", async () => {
    const { container } = render(<TextCompareView {...props} layout="side-by-side" />);
    await waitFor(() => expect(container.querySelectorAll(".cm-mergeViewEditor").length).toBe(2));
    expect(container.querySelectorAll('.cm-content[contenteditable="true"]').length).toBe(0);
    expect(screen.getAllByText("當時").length).toBeGreaterThan(0);
    expect(screen.getAllByText("現在").length).toBeGreaterThan(0);
  });

  it("one column: a single editor that marks removed and added text", async () => {
    const { container } = render(<TextCompareView {...props} layout="single" />);
    await waitFor(() => expect(container.querySelectorAll(".cm-editor").length).toBe(1));
    expect(container.querySelector(".cm-mergeView")).toBeNull();
    expect(container.querySelector(".cm-content")!.textContent).toContain("第二段改了");
  });

  it("counts the places and steps through them", async () => {
    render(<TextCompareView {...props} layout="single" />);
    await screen.findByText("第 1 處，共 2 處");
    fireEvent.click(screen.getByLabelText("下一處"));
    await screen.findByText("第 2 處，共 2 處");
    fireEvent.click(screen.getByLabelText("下一處"));
    await screen.findByText("第 1 處，共 2 處");
  });

  it("folds the stretches that did not change", async () => {
    const { container } = render(<TextCompareView {...props} layout="single" />);
    await waitFor(() => expect(container.querySelector(".cm-collapsedLines")).not.toBeNull());
    expect(container.querySelector(".cm-collapsedLines")!.textContent).toMatch(/略過 \d+ 行沒有變的內容/);
  });

  it("only reports: the caller gets the place, neither text is touched", async () => {
    const seen: ComparePlace[] = [];
    const onAccept = vi.fn();
    const { container } = render(<TextCompareView {...props} layout="single" placeActions={(place) => {
      seen.push(place);
      return <button type="button" onClick={() => onAccept(place.index)}>接受這處</button>;
    }} />);
    await screen.findByText("第 1 處，共 2 處");
    const doc = () => container.querySelector(".cm-content")!.textContent;
    const shown = doc();
    fireEvent.click(await screen.findByText("接受這處"));
    expect(onAccept).toHaveBeenCalledWith(0);
    expect(doc()).toBe(shown);
    expect(seen.at(-1)!.after.text).toContain("第二段改了");
    expect(seen.at(-1)!.before.text).toContain("第二段");
  });

  it("uses the caller's places: one place on screen per place given", async () => {
    const at = AFTER.indexOf("第二段改了");
    const from = BEFORE.indexOf("第二段");
    render(<TextCompareView {...props} layout="single" places={[{ before: { from, to: from + 3 }, after: { from: at, to: at + 5 } }]} />);
    await screen.findByText("第 1 處，共 1 處");
  });

  it("says so when there is nothing to compare, and shows no editor", async () => {
    const { container } = render(<TextCompareView {...props} after={BEFORE} layout="single" />);
    await screen.findByText("兩邊沒有差別。");
    expect(container.querySelector(".cm-mergeView")).toBeNull();
  });

  it("too long to compare: a plain sentence and the count, no editor", async () => {
    const clock = vi.spyOn(performance, "now");
    let t = 0;
    clock.mockImplementation(() => (t += 1000));
    const { container } = render(<TextCompareView {...props} layout="single" />);
    clock.mockRestore();
    expect(screen.getByRole("status").textContent).toMatch(/太長.*只顯示總結：共有 \d+ 處不同/);
    expect(container.querySelector(".cm-editor")).toBeNull();
  });
});

describe("placeTouches", () => {
  const place = (from: number, to: number): ComparePlace => ({ index: 0, before: { from: 0, to: 0, text: "" }, after: { from, to, text: "" } });
  it("overlap counts, a shared edge does not, a removal point inside does", () => {
    expect(placeTouches(place(10, 20), { from: 15, to: 25 })).toBe(true);
    expect(placeTouches(place(10, 20), { from: 20, to: 30 })).toBe(false);
    expect(placeTouches(place(10, 20), { from: 12, to: 12 })).toBe(true);
    expect(placeTouches(place(10, 10), { from: 10, to: 10 })).toBe(true);
  });
});
