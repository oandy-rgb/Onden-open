// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import AppTopbar from "../components/AppTopbar";
import MobileNav from "../components/MobileNav";
import { getAppState, resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { setPending } from "../lib/data/syncStatus";
import { bindAccountStorage } from "../lib/accountStorage";
import { pageLifecycle } from "../lib/signOut";

// The page belongs to account "u" (AccountSessionBoundary binds it in the app):
// the shell shows that session's account, and sign-out reloads the page.
bindAccountStorage("u", window.location.origin);

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), prepare: vi.fn() }));
vi.mock("../lib/auth-client", () => ({ authClient: { signOut: mocks.signOut,
  useSession: () => ({ data: { user: { id: "u", name: "Test Student", email: "student@example.test" } } }) } }));
vi.mock("../lib/data/draftActions", () => ({ prepareEditorForExit: mocks.prepare }));

const originalMatchMedia = window.matchMedia;
/** The phone layout (≤900px) or a desktop window. */
function layoutIs(layout: "mobile" | "desktop") {
  window.matchMedia = vi.fn((query: string) => ({
    matches: layout === "mobile" && query === "(max-width: 900px)",
    media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// Both layouts open the account from the top-bar avatar; the phone also has
// the bottom bar (whose More sheet is navigation only).
function renderShell(layout: "mobile" | "desktop", sync = vi.fn(async () => ({ ok: true }))) {
  layoutIs(layout);
  const actors = vi.fn();
  const settings = vi.fn();
  const common = { mode: "notes" as const, setMode: vi.fn(),
    onOpenFeature: vi.fn(), onSyncNow: sync };
  render(<>
    <AppTopbar {...common} onOpenModule={vi.fn()} onOpenSettings={settings} onOpenMembers={actors} onOpenPalette={vi.fn()} />
    {layout === "mobile" && <MobileNav {...common} onCapture={vi.fn()} />}
  </>);
  fireEvent.click(screen.getByRole("button", { name: /Test Student/ }));
  return { dialog: screen.getByRole("dialog"), sync, actors, settings };
}
beforeEach(() => {
  mocks.signOut.mockReset().mockResolvedValue({ data: { success: true }, error: null });
  mocks.prepare.mockReset().mockResolvedValue(true);
  vi.spyOn(pageLifecycle, "reload").mockImplementation(() => {});
  resetAppState({ data: { ...noWorkspaceData, actor_role: "editor", actor_is_owner: false }, online: true }); setPending(0);
});
afterEach(() => { setPending(0); vi.restoreAllMocks(); window.matchMedia = originalMatchMedia; });

for (const layout of ["mobile", "desktop"] as const) describe(`${layout} account operation`, () => {
  it("shows the current account and does not offer admin actions to an editor", () => {
    const { dialog } = renderShell(layout);
    expect(within(dialog).getByText("student@example.test")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "Spaces and members" })).toBeNull();
  });
  it("exposes the same user management operation to the workspace owner", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true }, online: true });
    const { dialog, actors } = renderShell(layout);
    fireEvent.click(within(dialog).getByRole("button", { name: "Spaces and members" }));
    expect(actors).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not offer user management to an admin who is not the owner", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: false }, online: true });
    const { dialog } = renderShell(layout);
    expect(within(dialog).queryByRole("button", { name: "Spaces and members" })).toBeNull();
  });
  it("cycles keyboard focus within account actions", () => {
    const { dialog } = renderShell(layout);
    const buttons = within(dialog).getAllByRole("button");
    const first = buttons[0], last = buttons[buttons.length - 1];
    first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" }); expect(first).toHaveFocus();
    fireEvent.click(first); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("waits for draft preservation and prevents dismissal or repeated sign-out", async () => {
    let saved!: (ok: boolean) => void;
    mocks.prepare.mockImplementation(() => new Promise(resolve => { saved = resolve; }));
    const { dialog } = renderShell(layout);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Saving and signing out…" }));
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(mocks.prepare).toHaveBeenCalledOnce();
    await act(async () => saved(true)); expect(mocks.signOut).toHaveBeenCalledOnce();
  });
  it("a confirmed sign-out forgets the account for offline starts (GAP-20)", async () => {
    mocks.prepare.mockResolvedValue(true);
    localStorage.setItem("onden_verified_account", JSON.stringify({ server: window.location.origin, userId: "u" }));
    const { dialog } = renderShell(layout);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })));
    expect(localStorage.getItem("onden_verified_account")).toBeNull();
  });
  it("an unconfirmed sign-out keeps it", async () => {
    mocks.prepare.mockResolvedValue(true);
    mocks.signOut.mockResolvedValueOnce({ error: { status: 503 } });
    localStorage.setItem("onden_verified_account", JSON.stringify({ server: window.location.origin, userId: "u" }));
    const { dialog } = renderShell(layout);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })));
    expect(localStorage.getItem("onden_verified_account")).not.toBeNull();
    localStorage.removeItem("onden_verified_account");
  });
  it("keeps the account and input when preparation refuses", async () => {
    mocks.prepare.mockResolvedValue(false);
    const { dialog } = renderShell(layout);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })));
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Sign-out paused");
    expect(within(dialog).getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
  it.each(["resolved", "rejected"])("retains an actionable error for a %s auth failure and permits retry", async kind => {
    if (kind === "resolved") mocks.signOut.mockResolvedValueOnce({ error: { status: 503 } });
    else mocks.signOut.mockRejectedValueOnce(new TypeError("network lost"));
    const { dialog } = renderShell(layout);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Could not confirm sign-out");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })));
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
  });
});

describe("one Settings entry", () => {
  it("phone: Settings is only in the avatar's sheet, with the sync status (no gear, none in More)", () => {
    const { dialog, settings } = renderShell("mobile");
    expect(within(dialog).getByText("Connected")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull(); // no top-bar gear
    fireEvent.click(screen.getAllByRole("button", { name: "More" }).find((b) => !b.classList.contains("topbar-more-btn"))!); // the phone bar's, not the desktop 更多 ▾
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Settings" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Test Student/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getAllByRole("button", { name: "Settings" })).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole("button", { name: "Settings" }));
    expect(settings).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("phone: the sheet lists identity, sync, Settings, then the account actions", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true }, online: true });
    const { dialog } = renderShell("mobile");
    expect(within(dialog).getAllByRole("button").map(button => button.textContent))
      .toEqual(["", "Settings", "Spaces and members", "Sign out"]);
  });
  it("phone: offline, the sheet says so", () => {
    resetAppState({ data: noWorkspaceData, online: false });
    const { dialog } = renderShell("mobile");
    expect(within(dialog).getByText("Offline — changes save locally")).toBeVisible();
  });
  it("desktop: the dialog has the sync status; Settings is the gear in the bar, its only entry", () => {
    const { dialog, settings } = renderShell("desktop");
    expect(within(dialog).getByText("Connected")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Settings" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(settings).toHaveBeenCalledOnce();
  });
});

describe("mobile sync visibility", () => {
  it("shows pending work outside the account sheet, keeps offline work visible and disables manual sync", () => {
    setPending(2); resetAppState({ data: noWorkspaceData, online: false });
    const { dialog, sync } = renderShell("mobile");
    expect(within(dialog).getByRole("button", { name: "2 changes waiting to sync" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const strip = document.querySelector<HTMLElement>(".mobile-sync-strip")!;
    expect(within(strip).getByRole("button", { name: "2 changes waiting to sync" })).toBeVisible();
    expect(sync).not.toHaveBeenCalled();
  });
  it("waits for sync, reports an incomplete pass once, and keeps the real queue count", async () => {
    setPending(2); let complete!: (result: { ok: boolean }) => void;
    const sync = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { complete = resolve; }));
    const { dialog } = renderShell("mobile", sync);
    const button = within(dialog).getByRole("button", { name: /2 changes waiting to sync/ });
    fireEvent.click(button); fireEvent.click(button);
    expect(sync).toHaveBeenCalledOnce(); expect(within(dialog).getByText("Syncing…")).toBeVisible();
    await act(async () => complete({ ok: false }));
    expect(within(dialog).getByRole("button", { name: /2 changes waiting to sync/ })).toBeEnabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Sync could not finish");
    expect(getAppState().toasts).toHaveLength(0);
  });
});

describe("one sign-out (lib/signOut.ts)", () => {
  it("the account menu saves, signs out, then reloads the page", async () => {
    const { dialog } = renderShell("desktop");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" })); });
    expect(mocks.prepare).toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalled();
    expect(pageLifecycle.reload).toHaveBeenCalledTimes(1);
  });

  it("the access-revoked screen signs out without waiting for saves, then reloads", async () => {
    const { default: AccessRevokedNotice } = await import("../components/AccessRevokedNotice");
    mocks.prepare.mockResolvedValue(false); // a save that can never land for a removed account
    render(<AccessRevokedNotice />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalled();
    expect(pageLifecycle.reload).toHaveBeenCalledTimes(1);
  });
});
