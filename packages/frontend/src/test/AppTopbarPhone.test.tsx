// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import AppTopbar from "../components/AppTopbar";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { setPending } from "../lib/data/syncStatus";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

// Phone top bar: no layout switch (there is no sidebar), and no
// standing "connected" dot. Trouble (offline / waiting to sync) is a small
// badge on the avatar with an accessible label.

vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", name: "Andy", email: "a@example.com" } } }), signOut: vi.fn() },
}));
vi.mock("../lib/accountStorage", async (original) => ({ ...await original<typeof import("../lib/accountStorage")>(), boundAccountId: () => "u1" }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));

function renderTopbar(online = true) {
  resetAppState({ data: { ...noWorkspaceData }, online });
  return render(
    <AppTopbar mode="notes" setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} onOpenPalette={vi.fn()}
      onOpenMembers={vi.fn()} onOpenSettings={vi.fn()} />,
  );
}

describe("AppTopbar on a phone", () => {
  beforeEach(() => { setPending(0); setPhoneLayout(true); });
  afterEach(() => { cleanup(); clearPhoneLayout(); setPending(0); });

  it("has no layout switch, and none of the desktop's three segments", () => {
    const { container } = renderTopbar();
    expect(screen.queryByRole("button", { name: /notes list|info/i })).toBeNull();
    expect(container.querySelector(".topbar-pane-switch")).toBeNull();
  });

  it("shows no status dot or badge while online and synced", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".status-dot")).toBeNull();
    expect(container.querySelector(".user-badge")).toBeNull();
    expect(screen.queryByTitle("Connected")).toBeNull();
  });

  it("offline: a badge on the avatar, with a label", () => {
    const { container } = renderTopbar(false);
    const badge = screen.getByRole("img", { name: "Offline — changes save locally" });
    expect(container.querySelector(".user-chip")).toContainElement(badge);
    expect(badge).toHaveClass("user-badge--offline");
  });

  it("changes waiting to sync: a badge with the count in its label", () => {
    renderTopbar();
    act(() => setPending(2));
    expect(screen.getByRole("img", { name: "2 changes waiting to sync" })).toHaveClass("user-badge--pending");
  });

  it("the account panel is the shared ui/Sheet, not a card of its own", () => {
    renderTopbar();
    fireEvent.click(screen.getByRole("button", { name: /a@example\.com|A/ }));
    const dialog = screen.getByRole("dialog", { name: "Account" });
    expect(dialog.querySelector(".ui-sheet-handle")).not.toBeNull();
    expect(dialog.closest(".ui-sheet") ?? dialog.querySelector(".ui-sheet")).not.toBeNull();
  });

  it("the badge goes away when the queue drains", () => {
    renderTopbar();
    act(() => setPending(2));
    act(() => setPending(0));
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("AppTopbar on desktop", () => {
  beforeEach(() => { setPending(0); setPhoneLayout(false); });
  afterEach(() => { cleanup(); clearPhoneLayout(); setPending(0); });

  it("has the same avatar badge as the phone and no standing connection dot; Settings is the bar's last item", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".status-dot")).toBeNull();
    expect(container.querySelector(".app-topbar-right")?.lastElementChild).toBe(screen.getByRole("button", { name: "Settings" }));
    expect(container.querySelector(".user-badge")).toBeNull();
    act(() => setPending(2));
    expect(container.querySelector(".user-avatar")).toContainElement(screen.getByRole("img", { name: "2 changes waiting to sync" }));
  });

  it("offline: the avatar says so", () => {
    renderTopbar(false);
    expect(screen.getByRole("img", { name: "Offline — changes save locally" })).toHaveClass("user-badge--offline");
  });
});
