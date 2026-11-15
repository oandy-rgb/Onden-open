import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Users } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PanelHeader from "./PanelHeader";
import { clearPhoneLayout, setPhoneLayout } from "../test/phoneMedia";

afterEach(() => { cleanup(); clearPhoneLayout(); });

const header = (onClose = () => {}) =>
  render(<PanelHeader icon={<Users data-testid="icon" size={16} />} title="Users & Agents" onClose={onClose} />);

describe("PanelHeader on a phone", () => {
  it("is one row: 返回 at the left, the icon inline with the title, no close box", () => {
    setPhoneLayout(true);
    const { container } = header();
    const row = container.querySelector(".panel-header")!;
    expect(row).toHaveClass("panel-header--phone");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    const back = screen.getByRole("button", { name: "Back" });
    expect(row.firstElementChild).toBe(back);
    // The icon is inside the heading, not a sibling on its own line.
    const title = screen.getByRole("heading", { name: "Users & Agents" });
    expect(title).toContainElement(screen.getByTestId("icon"));
  });

  it("Back runs onClose", () => {
    setPhoneLayout(true);
    const onClose = vi.fn();
    header(onClose);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("without onClose it is a plain title row", () => {
    setPhoneLayout(true);
    render(<PanelHeader icon={null} title="Review" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("PanelHeader on desktop", () => {
  it("keeps the title with Close at the right and no Back", () => {
    setPhoneLayout(false);
    const onClose = vi.fn();
    header(onClose);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeAs=icon keeps an accessible name", () => {
    setPhoneLayout(false);
    render(<PanelHeader icon={null} title="Ask" onClose={() => {}} closeAs="icon" />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
