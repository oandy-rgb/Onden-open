import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pressable } from "../components/ui";

describe("Pressable", () => {
  it("is a type=button that fires onClick and keeps aria-label", () => {
    const onClick = vi.fn();
    render(<Pressable aria-label="開啟" className="x" onClick={onClick}>go</Pressable>);
    const b = screen.getByRole("button", { name: "開啟" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.className).toContain("x");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("responds to Enter and Space from the keyboard", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Pressable onClick={onClick}>go</Pressable>);
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<Pressable disabled onClick={onClick}>a</Pressable>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
