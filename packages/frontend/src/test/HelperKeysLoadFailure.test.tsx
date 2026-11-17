import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HelperKeys from "../settings/spacesAndMembers/HelperKeys";
import type { RosterPerson } from "../settings/spacesAndMembers/roster";
import { setLocalePref } from "../lib/i18n";

const h = vi.hoisted(() => ({ actorTokens: vi.fn(), sendWrite: vi.fn() }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  reads: { people: { actorTokens: h.actorTokens } },
}));
vi.mock("../lib/data/onlineWrite", async (original) => ({ ...await original<typeof import("../lib/data/onlineWrite")>(), sendWrite: h.sendWrite }));

const person = {
  id: "helper-1", name: "Helper", type: "agent", isOwner: false, invitePending: false, inviteEmail: null,
  inviteExpiresAt: null, permissions: { s1: "edit" }, liveKeys: 1, writeKeys: 0, reach: {}, signedIn: true,
} as unknown as RosterPerson;
const key = { id: "k1", name: "Desk key", access: "read", last_used_at: null, expires_at: null, revoked_at: null };

beforeEach(() => { h.actorTokens.mockReset(); h.sendWrite.mockReset().mockResolvedValue({ token: "plain" }); setLocalePref("en"); });
afterEach(() => { cleanup(); setLocalePref("system"); });

describe("helper keys list", () => {
  it("says the keys could not be loaded, with Try again, instead of 'No keys yet.'", async () => {
    h.actorTokens.mockRejectedValueOnce(new Error("network down"));
    render(<HelperKeys person={person} online onChanged={vi.fn()} />);
    expect(await screen.findByText(/Couldn't load the keys/)).toBeVisible();
    expect(screen.queryByText("No keys yet.")).toBeNull();
    expect(document.body.textContent).not.toMatch(/network down/);
    h.actorTokens.mockResolvedValueOnce([key]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Desk key")).toBeVisible();
    expect(screen.queryByText(/Couldn't load the keys/)).toBeNull();
  });

  it("still says 'No keys yet.' when the read succeeded with nothing", async () => {
    h.actorTokens.mockResolvedValueOnce([]);
    render(<HelperKeys person={person} online onChanged={vi.fn()} />);
    expect(await screen.findByText("No keys yet.")).toBeVisible();
  });

  it("keeps the keys already shown when a later reload fails, with the error above them", async () => {
    h.actorTokens.mockResolvedValueOnce([key]);
    render(<HelperKeys person={person} online onChanged={vi.fn()} />);
    expect(await screen.findByText("Desk key")).toBeVisible();
    h.actorTokens.mockRejectedValueOnce(new Error("network down")).mockResolvedValue([key]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue key" }));
    expect(await screen.findByText(/Couldn't load the keys/)).toBeVisible();
    expect(screen.getByText("Desk key")).toBeVisible();
  });
});
