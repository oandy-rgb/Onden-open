import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pressable } from "../components/ui";

describe("Pressable", () => {
  it("is a type=button that keeps the caller's class, aria and click/keyboard activation", async () => {
    const onClick = vi.fn();
    render(<Pressable className="my-row" aria-label="選取" onClick={onClick}>列</Pressable>);
    const el = screen.getByRole("button", { name: "選取" });
    expect(el).toHaveAttribute("type", "button");
    expect(el).toHaveClass("ui-pressable", "my-row");
    await userEvent.click(el);
    el.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("does not fire when disabled", async () => {
    const onClick = vi.fn();
    render(<Pressable disabled onClick={onClick}>x</Pressable>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
