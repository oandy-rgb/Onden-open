import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pressable } from "../components/ui";

describe("Pressable", () => {
  it("is a type=button that fires onClick, keeps aria-label and the caller's class", () => {
    const onClick = vi.fn();
    render(<Pressable className="mine" aria-label="開啟" onClick={onClick}>x</Pressable>);
    const b = screen.getByRole("button", { name: "開啟" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.className).toContain("mine");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<Pressable disabled onClick={onClick}>x</Pressable>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
