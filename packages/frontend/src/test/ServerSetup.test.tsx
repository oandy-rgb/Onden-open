import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// setApiBase (the checked one, lib/api) is the only api.ts surface ServerSetup
// touches; its check has its own suite (setApiBase.test.ts). Here: what base
// each path asks for, and what the screen does with the answer.
vi.mock("../lib/api", () => ({ setApiBase: vi.fn(), pageOrigin: () => window.location.origin }));

import { setApiBase } from "../lib/api";
import ServerSetup from "../components/ServerSetup";

const setApiBaseMock = vi.mocked(setApiBase);

describe("ServerSetup (no jargon wall)", () => {
  beforeEach(() => {
    setApiBaseMock.mockReset();
    setApiBaseMock.mockResolvedValue({ ok: true, changed: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows no backend-URL field by default — the common user sees only Connect", () => {
    render(<ServerSetup onConnect={() => {}} />);
    expect(screen.queryByPlaceholderText("https://your-server.com")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Advanced / connect to a different server" }),
    ).toBeTruthy();
  });

  it("default Connect asks for same-origin (empty base → /api on this host)", async () => {
    const onConnect = vi.fn();
    render(<ServerSetup onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(setApiBaseMock).toHaveBeenCalledWith("");
  });

  it("Advanced reveals the URL field and asks for the typed host", async () => {
    const onConnect = vi.fn();
    render(<ServerSetup onConnect={onConnect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Advanced / connect to a different server" }),
    );
    const input = screen.getByPlaceholderText("https://your-server.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://other.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(setApiBaseMock).toHaveBeenCalledWith("https://other.example.com/");
  });

  it("a refused server shows the reason and does not connect", async () => {
    setApiBaseMock.mockResolvedValue({ ok: false, error: "This address is not an Onden server." });
    const onConnect = vi.fn();
    render(<ServerSetup onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("This address is not an Onden server.")).toBeTruthy();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("a changed server leaves the page to setApiBase's reload instead of connecting in place", async () => {
    setApiBaseMock.mockResolvedValue({ ok: true, changed: true });
    const onConnect = vi.fn();
    render(<ServerSetup onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(setApiBaseMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(onConnect).not.toHaveBeenCalled();
  });
});
