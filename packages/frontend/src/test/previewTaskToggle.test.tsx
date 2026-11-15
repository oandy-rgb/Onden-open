// J03: a task box in the note's preview toggles its line when the viewer can
// edit, and stays a labelled read-only checkbox when they cannot.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import OverviewPreview from "../components/OverviewPreview";

describe("OverviewPreview task boxes", () => {
  it("reports the clicked box's index to onToggleTask", () => {
    const onToggleTask = vi.fn();
    const { container } = render(
      <OverviewPreview draft={"- [ ] one\n- [x] two"} nodes={[]} onOpenWikilink={vi.fn()} onToggleTask={onToggleTask} />,
    );
    const boxes = container.querySelectorAll('[role="checkbox"]');
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]);
    expect(onToggleTask).toHaveBeenCalledWith(1);
  });

  it("without a handler the boxes are visible to assistive tech but read-only", () => {
    const { container } = render(
      <OverviewPreview draft={"- [ ] one"} nodes={[]} onOpenWikilink={vi.fn()} />,
    );
    const box = container.querySelector('[role="checkbox"]')!;
    expect(box.getAttribute("aria-readonly")).toBe("true");
    expect(box.getAttribute("aria-hidden")).toBeNull();
  });
});
