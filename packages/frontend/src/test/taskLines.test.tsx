import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { taskLines } from "../lib/taskLines";
import { toggleTaskLine } from "../lib/taskCheckbox";

// One reading of a note's task items for the checkbox click (unification audit W15). The click addresses boxes by
// their rendered order, so a `- [ ]` inside a code block — shown as text, not
// as a box — must not be counted, or the click ticks the wrong line.

const note = [
  "- [ ] first",          // 0 → task 0
  "```",                  // 1
  "- [ ] shown as code",  // 2 (not a box)
  "```",                  // 3
  "> - [x] quoted done",  // 4 → task 1
  "> > * [ ] deep quote", // 5 → task 2
  "~~~~md",               // 6
  "~~~",                  // 7 (shorter: does not close)
  "1. [ ] still code",    // 8 (not a box)
  "~~~~",                 // 9
  "2) [ ] last",          // 10 → task 3
].join("\n");

describe("taskLines", () => {
  it("skips fenced code blocks (``` and ~~~, a shorter fence doesn't close) and reads block quotes", () => {
    expect(taskLines(note).map((t) => [t.line, t.checked, t.text])).toEqual([
      [0, false, "first"], [4, true, "quoted done"], [5, false, "deep quote"], [10, false, "last"],
    ]);
  });

  it("a click on the 2nd rendered box ticks the quoted item, not the line in the code block", () => {
    const next = toggleTaskLine(note, 2).split("\n");
    expect(next[5]).toBe("> > * [x] deep quote");
    expect(next[2]).toBe("- [ ] shown as code");
  });

  it("a fence inside a quote is a code block too", () => {
    expect(taskLines("> ```\n> - [ ] code\n> ```\n- [ ] real").map((t) => t.line)).toEqual([3]);
  });
});

describe("the renderer and taskLines agree", () => {
  it("renders one checkbox per task line, in the same order, and the Nth click names the Nth line", () => {
    const onToggleTask = vi.fn();
    render(<MarkdownRenderer onToggleTask={onToggleTask}>{note}</MarkdownRenderer>);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(taskLines(note).length);
    fireEvent.click(boxes[2]!);
    expect(onToggleTask).toHaveBeenCalledWith(2);
    expect(taskLines(note)[2]!.text).toBe("deep quote");
  });
});

// Every case: the renderer's box count must equal taskLines' count, and a
// click on the last box must tick exactly that item's line.
const CASES: Array<[string, string, number]> = [
  ["plain list", "- [ ] a\n- [x] b", 2],
  ["fence inside a quote, left open until the quote ends", "> ```\n> - [ ] code\n\n- [ ] after", 1],
  ["fence inside a list item, left open until the item ends", "- item\n  ```\n  - [ ] code\n\n- [ ] after", 1],
  ["indented code inside a list", "- item\n\n      - [ ] indented code\n\n- [ ] real", 1],
  ["empty box draws nothing", "- [ ]\n- [ ] real", 1],
  ["no space after the box draws nothing", "- [x]foo\n- [ ] real", 1],
  ["a quote's fence does not close an outer one", "```\n> ```\n- [ ] still code\n```\n- [ ] real", 1],
  ["CRLF line endings", "- [ ] one\r\n- [ ] two\r\n", 2],
  ["nested lists", "- [ ] parent\n  - [x] child\n    - [ ] grandchild", 3],
  ["ordered and starred markers", "1. [ ] one\n2) [X] two\n* [ ] three", 3],
];

describe("taskLines matches the renderer, case by case", () => {
  for (const [name, md, boxes] of CASES) {
    it(name, () => {
      const onToggleTask = vi.fn();
      const { unmount } = render(<MarkdownRenderer onToggleTask={onToggleTask}>{md}</MarkdownRenderer>);
      const rendered = screen.queryAllByRole("checkbox");
      expect(rendered).toHaveLength(boxes);
      expect(taskLines(md)).toHaveLength(boxes);
      fireEvent.click(rendered[boxes - 1]!);
      expect(onToggleTask).toHaveBeenCalledWith(boxes - 1);
      const last = taskLines(md)[boxes - 1]!;
      const toggled = toggleTaskLine(md, boxes - 1);
      expect(taskLines(toggled)[boxes - 1]!.checked).toBe(!last.checked);
      expect(toggled.length).toBe(md.length); // one character flipped, nothing else
      unmount();
    });
  }
});
