// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pressable } from "../components/ui";

describe("Pressable", () => {
  it("is a type=button that fires onClick by click and keyboard, and keeps aria-label and the caller's class", async () => {
    const onClick = vi.fn();
    render(<Pressable className="x" aria-label="Open" onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Open" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.className).toContain("x");
    fireEvent.click(b);
    const user = userEvent.setup();
    b.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
