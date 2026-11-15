import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LoadError } from "../components/ui";

describe("history: couldn't load", () => {
  it("online, says the history couldn't load; Try again retries", () => {
    const retry = vi.fn();
    render(<LoadError failed="Couldn't load the history." online onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the history.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offline, says the server can't be reached instead", () => {
    render(<LoadError failed="Couldn't load the history." online={false} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server.");
  });
});
