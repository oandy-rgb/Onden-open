// Logseq 2.0.2 cross-check: a settings toggle reports the value the user just
// chose (the opposite of what it showed), and again after it re-renders.
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "../components/ui";

describe("Switch", () => {
  it("passes the newly chosen value on every flip, never the stale one", async () => {
    const seen: boolean[] = [];
    function Host() {
      const [on, setOn] = useState(false);
      return <Switch on={on} label="x" onChange={(next) => { seen.push(next); setOn(next); }} />;
    }
    render(<Host />);
    const sw = screen.getByRole("switch");
    await userEvent.click(sw);
    await userEvent.click(sw);
    await userEvent.click(sw);
    expect(seen).toEqual([true, false, true]);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("a disabled switch reports nothing", async () => {
    const onChange = vi.fn();
    render(<Switch on label="x" disabled onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
