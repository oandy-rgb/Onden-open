import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// AppTopbar reads the session for the user chip; stub it so the component
// mounts without a real auth round-trip.
vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: userSession.current }),
    signOut: vi.fn(),
  },
}));

vi.mock("../lib/accountStorage", async (original) => ({ ...await original<typeof import("../lib/accountStorage")>(), boundAccountId: () => "u1" }));
const userSession = vi.hoisted(() => ({ current: null as null | { user: { id: string; name: string; email: string } } }));
import AppTopbar from "../components/AppTopbar";
import { setPhoneLayout, clearPhoneLayout } from "./phoneMedia";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";

function renderTopbar(overrides: Partial<Parameters<typeof AppTopbar>[0]> = {}) {
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  const onOpenPalette = vi.fn();
  render(
    <AppTopbar
      mode="notes"
      setMode={vi.fn()}
      onOpenModule={vi.fn()} onOpenFeature={vi.fn()}
      onOpenPalette={onOpenPalette}
      onOpenMembers={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />,
  );
  return { onOpenPalette };
}

describe("AppTopbar persistent search", () => {
  beforeEach(() => { localStorage.clear(); userSession.current = { user: { id: "u1", name: "Andy", email: "a@example.com" } }; });
  afterEach(() => { clearPhoneLayout(); });

  it("on a desktop the palette button is the only search", () => {
    renderTopbar();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Command palette" })).toHaveLength(1);
  });

  it("keeps the desktop command palette reachable through its persistent button", () => {
    const { onOpenPalette } = renderTopbar();
    const btn = screen.getByRole("button", { name: "Command palette" });
    expect(btn).toHaveClass("topbar-desktop-only");
    fireEvent.click(btn);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("on a phone a search button opens the palette", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("max-width: 900px"), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const { onOpenPalette } = renderTopbar();
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      expect(onOpenPalette).toHaveBeenCalledTimes(1);
    } finally { window.matchMedia = original; }
  });

  it("on a phone the avatar is the last item on the right; on a computer it stays before the layout switch", () => {
    setPhoneLayout(true);
    renderTopbar();
    const right = document.querySelector(".app-topbar-right")!;
    expect(right.lastElementChild).toBe(right.querySelector(".user-menu-wrap"));
    expect(right.querySelector(".topbar-phone-search")!.compareDocumentPosition(right.querySelector(".user-menu-wrap")!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    clearPhoneLayout();
    renderTopbar();
    const desktop = document.querySelector(".app-topbar-right")!;
    expect(desktop.querySelector(".user-menu-wrap")!.nextElementSibling).toBe(desktop.querySelector(".topbar-pane-switch"));
  });

  it("a phone has no standing Settings button (it is in the avatar's sheet); a computer has the gear", () => {
    setPhoneLayout(true);
    try {
      renderTopbar();
      expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
      cleanup();
    } finally { clearPhoneLayout(); }
    renderTopbar();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
  });
});
