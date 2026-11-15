import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tab, TabList, TabPanel } from "../components/ui";

function Example({ onPick }: { onPick: (id: string) => void }) {
  return (
    <>
      <TabList label="Demo">
        {["a", "b", "c"].map((id) => (
          <Tab key={id} id={`t-${id}`} selected={id === "a"} controls="p" onClick={() => onPick(id)}>{id}</Tab>
        ))}
      </TabList>
      <TabPanel id="p" labelledBy="t-a">body</TabPanel>
    </>
  );
}

describe("ui Tabs", () => {
  it("wires roles, aria-selected, aria-controls and the roving tab stop", () => {
    render(<Example onPick={() => {}} />);
    expect(screen.getByRole("tablist", { name: "Demo" })).toBeTruthy();
    const [a, b] = screen.getAllByRole("tab");
    expect(a!.getAttribute("aria-selected")).toBe("true");
    expect(b!.getAttribute("aria-selected")).toBe("false");
    expect(a!.getAttribute("aria-controls")).toBe("p");
    expect(a!.tabIndex).toBe(0);
    expect(b!.tabIndex).toBe(-1);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("t-a");
  });

  it("arrows, Home and End move focus and select (wrapping around)", () => {
    const onPick = vi.fn();
    render(<Example onPick={onPick} />);
    const [a, b, c] = screen.getAllByRole("tab");
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b!, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "Home" });
    expect(document.activeElement).toBe(a);
    expect(onPick.mock.calls.map(([id]) => id)).toEqual(["b", "c", "a", "c", "a"]);
  });
});
