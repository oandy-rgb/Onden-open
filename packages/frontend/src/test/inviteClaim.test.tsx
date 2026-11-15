import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

import { api, ApiError } from "../lib/api";
import { captureInviteFromUrl, forgetInviteToken, inviteRequestHeaders, pendingInviteToken } from "../lib/invite";
import InviteClaimGate from "../components/InviteClaimGate";

// D110: the one-time invite link. `?invite=` is read once at boot and kept for
// the tab; after sign-in the claim runs BEFORE the workspace mounts, and a
// refused link says why.

const apiMock = vi.mocked(api);
// The gate loads lib/data on demand; with several vitest workers busy the first
// import outlasts findBy*'s default 1 s.
const SLOW_IMPORT = { timeout: 15_000 };

describe("invite link capture", () => {
  beforeEach(() => { forgetInviteToken(); window.history.replaceState(null, "", "/"); });

  it("reads ?invite= once, keeps it for the tab, and strips it from the address", () => {
    window.history.replaceState(null, "", "/?invite=ondi_abc&view=notes#x");
    expect(captureInviteFromUrl()).toBe("ondi_abc");
    expect(window.location.search).toBe("?view=notes");
    expect(window.location.hash).toBe("#x");
    expect(pendingInviteToken()).toBe("ondi_abc");
    expect(inviteRequestHeaders()).toEqual({ "X-Onden-Invite": "ondi_abc" });
    forgetInviteToken();
    expect(pendingInviteToken()).toBeNull();
    expect(inviteRequestHeaders()).toEqual({});
  });
});

describe("InviteClaimGate", () => {
  beforeEach(() => { apiMock.mockReset(); forgetInviteToken(); window.history.replaceState(null, "", "/"); });

  it("with no invite pending, shows the workspace at once and sends nothing", () => {
    render(<InviteClaimGate><p>workspace</p></InviteClaimGate>);
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("claims first, then mounts the workspace and forgets the token", async () => {
    window.history.replaceState(null, "", "/?invite=ondi_ok");
    captureInviteFromUrl();
    let resolve!: (v: unknown) => void;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      expect(path).toBe("/api/invites/claim");
      expect(JSON.parse(String(init?.body))).toEqual({ token: "ondi_ok" });
      return new Promise((r) => { resolve = r; });
    });
    render(<InviteClaimGate><p>workspace</p></InviteClaimGate>);
    expect(screen.queryByText("workspace")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Accepting the invite…");
    // The gate loads lib/data on demand; the first import in a test run is slow.
    await waitFor(() => expect(resolve).toBeTypeOf("function"), { timeout: 15_000 });
    resolve({ actor: { id: "bob" } });
    expect(await screen.findByText("workspace", {}, SLOW_IMPORT)).toBeInTheDocument();
    expect(pendingInviteToken()).toBeNull();
  }, 30_000);

  it("an expired link says so; continuing without it opens the workspace", async () => {
    window.history.replaceState(null, "", "/?invite=ondi_old");
    captureInviteFromUrl();
    apiMock.mockRejectedValue(new ApiError(410, JSON.stringify({ error: "invite_expired" })));
    render(<InviteClaimGate><p>workspace</p></InviteClaimGate>);
    expect(await screen.findByRole("alert", {}, SLOW_IMPORT)).toHaveTextContent("This invite link expired — ask the owner for a new one.");
    expect(screen.queryByText("workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue without the invite" }));
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(pendingInviteToken()).toBeNull();
  }, 30_000);
});
