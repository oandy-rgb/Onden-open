import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import AppTopbar from "../components/AppTopbar";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { setPending } from "../lib/data/syncStatus";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

// Durable pending-writes indicator (B): the desktop bar has no standing sync
// chip. Waiting changes show as a badge on the avatar, and the avatar's dialog
// shows how many are waiting and offers a manual sync when online — so a user
// can verify queued work is safe.

vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", name: "Andy", email: "a@example.com" } } }), signOut: vi.fn() },
}));
vi.mock("../lib/accountStorage", async (original) => ({ ...await original<typeof import("../lib/accountStorage")>(), boundAccountId: () => "u1" }));
// getPendingWrites isn't needed here — we drive the count directly via setPending.
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));

function renderTopbar(opts: { online?: boolean; onSyncNow?: () => void } = {}) {
  resetAppState({ data: { ...noWorkspaceData }, online: opts.online ?? true });
  return render(
    <AppTopbar
      mode="notes"
      setMode={vi.fn()}
      onOpenModule={vi.fn()} onOpenFeature={vi.fn()}
      onOpenPalette={vi.fn()}
      onOpenMembers={vi.fn()}
      onOpenSettings={vi.fn()}
      onSyncNow={opts.onSyncNow}
    />,
  );
}
const openAccount = () => {
  fireEvent.click(screen.getByRole("button", { name: /Andy/ }));
  return screen.getByRole("dialog");
};

describe("AppTopbar — durable pending-sync indicator", () => {
  beforeEach(() => { setPending(0); setPhoneLayout(false); });
  afterEach(() => { cleanup(); clearPhoneLayout(); vi.restoreAllMocks(); setPending(0); });

  it("nothing pending: no badge on the avatar and no standing dot or chip in the bar", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".user-badge")).toBeNull();
    expect(container.querySelector(".status-dot")).toBeNull();
    expect(screen.queryByTitle("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: /waiting to sync|sync now/i })).toBeNull();
    // The account dialog holds the status: zero pending is not "all saved" either.
    const dialog = openAccount();
    expect(within(dialog).getByText("Connected")).toBeInTheDocument();
    expect(within(dialog).queryByTitle(/all changes saved/i)).toBeNull();
  });

  it("writes waiting: a badge on the avatar, and the dialog shows the count with 'Sync now'", () => {
    renderTopbar({ online: true, onSyncNow: vi.fn() });
    act(() => setPending(3));
    expect(screen.getByRole("img", { name: "3 changes waiting to sync" })).toHaveClass("user-badge--pending");
    const btn = within(openAccount()).getByRole("button", { name: /3 changes waiting to sync/i });
    expect(btn).not.toBeDisabled();
  });

  it("the dialog's button triggers a manual sync (flush via onSyncNow)", () => {
    const onSyncNow = vi.fn();
    renderTopbar({ online: true, onSyncNow });
    act(() => setPending(2));
    fireEvent.click(within(openAccount()).getByRole("button", { name: /waiting to sync/i }));
    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  it("offline: shows the waiting count but the sync button is disabled (can't flush yet)", () => {
    renderTopbar({ online: false, onSyncNow: vi.fn() });
    act(() => setPending(5));
    expect(screen.getByRole("img", { name: "Offline — 5 changes will sync on reconnect" })).toHaveClass("user-badge--offline");
    const btn = within(openAccount()).getByRole("button", { name: /5 changes waiting to sync/i });
    expect(btn).toBeDisabled();
  });
});
