// The rendered GFM task checkbox is interactive when MarkdownRenderer is given
// an onToggleTask handler: a real keyboard-focusable role=checkbox button (not
// the inert aria-hidden span), reporting the checkbox's document-order index so
// the caller can flip the source line. Without a handler it stays read-only.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { toggleTaskLine } from "../lib/taskCheckbox";

const TASKS = ["- [ ] alpha", "- [x] beta", "- [ ] gamma"].join("\n");

describe("MarkdownRenderer interactive task checkbox", () => {
  it("without onToggleTask: renders inert read-only checkbox spans that still announce their state", () => {
    const { container } = render(<MarkdownRenderer>{TASKS}</MarkdownRenderer>);
    const spans = container.querySelectorAll("span.md-checkbox");
    expect(spans).toHaveLength(3);
    expect(container.querySelector("button.md-checkbox--interactive")).toBeNull();
    spans.forEach((s, i) => {
      expect(s.getAttribute("role")).toBe("checkbox");
      expect(s.getAttribute("aria-readonly")).toBe("true");
      expect(s.getAttribute("aria-checked")).toBe(i === 1 ? "true" : "false");
      expect(s.getAttribute("aria-hidden")).toBeNull();
    });
  });

  it("with onToggleTask: renders focusable role=checkbox buttons reflecting checked state", () => {
    const { container } = render(
      <MarkdownRenderer onToggleTask={() => {}}>{TASKS}</MarkdownRenderer>,
    );
    const boxes = container.querySelectorAll("button.md-checkbox--interactive");
    expect(boxes).toHaveLength(3);
    boxes.forEach((b) => {
      expect(b.getAttribute("role")).toBe("checkbox");
      expect(b.getAttribute("aria-hidden")).toBeNull();
    });
    expect(boxes[0].getAttribute("aria-checked")).toBe("false");
    expect(boxes[1].getAttribute("aria-checked")).toBe("true");
    expect(boxes[2].getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a checkbox reports its document-order index", () => {
    const calls: number[] = [];
    const { container } = render(
      <MarkdownRenderer onToggleTask={(i) => calls.push(i)}>{TASKS}</MarkdownRenderer>,
    );
    const boxes = container.querySelectorAll("button.md-checkbox--interactive");
    fireEvent.click(boxes[2]);
    fireEvent.click(boxes[0]);
    expect(calls).toEqual([2, 0]);
  });

  it("end to end: clicked index toggles the right source line via toggleTaskLine", () => {
    // Simulates the CardNode wiring: onToggleTask(i) => save(toggleTaskLine(src, i)).
    let src = TASKS;
    const save = vi.fn((next: string) => { src = next; });
    const { container } = render(
      <MarkdownRenderer onToggleTask={(i) => save(toggleTaskLine(src, i))}>{TASKS}</MarkdownRenderer>,
    );
    const boxes = container.querySelectorAll("button.md-checkbox--interactive");
    fireEvent.click(boxes[1]); // beta is checked → should become unchecked
    expect(save).toHaveBeenCalledWith(["- [ ] alpha", "- [ ] beta", "- [ ] gamma"].join("\n"));
  });
});
