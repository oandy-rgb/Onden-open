import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FilterChips } from "../components/ui";

const options = [
  { value: "", label: "All", count: 3 },
  { value: "a", label: "Feed A", count: 0 },
  { value: "b", label: "Feed B" },
];

describe("FilterChips", () => {
  it("one row of pressable tags: the chosen one is pressed, a click picks", () => {
    const onChange = vi.fn();
    render(<FilterChips label="Feeds" value="a" options={options} onChange={onChange} />);
    const row = screen.getByRole("toolbar", { name: "Feeds" });
    const [all, a, b] = within(row).getAllByRole("button");
    expect(a).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(b!);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("draws a count only when there is one", () => {
    render(<FilterChips label="Feeds" value={null} options={options} onChange={() => {}} />);
    const [all, a] = screen.getAllByRole("button");
    expect(within(all!).getByText("3")).toBeInTheDocument();
    expect(a!.querySelector(".ui-filter-chip__count")).toBeNull();
  });

  it("a long press on a tag runs its own action, not the browser menu; the trailing button stays outside the row", () => {
    const onMenu = vi.fn();
    render(<FilterChips label="Feeds" value={null} options={[{ value: "a", label: "Feed A", onContextMenu: onMenu }]} onChange={() => {}}
      trailing={<button type="button">Manage</button>} />);
    const tag = screen.getByText("Feed A").closest("button")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    tag.dispatchEvent(event);
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText("Manage").closest(".ui-filter-chips__row")).toBeNull();
  });
});
