// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import AppTopbar from "../components/AppTopbar";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { noWorkspaceData } from "../lib/api";
import { formatChord, resetShortcuts, setShortcutChord } from "../lib/shortcuts";

// better-auth's client touches the network on mount; stub useSession so the
// topbar renders in jsdom. The "New" button lives in the always-rendered left
// section, independent of session, but the component reads useSession() at top.
vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }), signOut: vi.fn() },
}));


function renderTopbar() {
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  return render(
    <AppTopbar
      mode="notes"
      setMode={vi.fn()}
      onOpenModule={vi.fn()} onOpenFeature={vi.fn()}
      onOpenPalette={vi.fn()}
      onOpenMembers={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

describe("AppTopbar — no capture button on desktop", () => {
  beforeEach(() => resetAppState({ data: { ...noWorkspaceData }, online: true }));
  afterEach(() => { act(() => setLocalePref("system")); vi.restoreAllMocks(); });

  it("has no Today button: today's note is ⌘⇧D, the palette and the 日記 page (daily-notes module)", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".topbar-today-btn")).toBeNull();
    expect(screen.queryByRole("button", { name: /Today's note/ })).toBeNull();
  });

  it("has no capture button: desktop captures with the hotkey (or the palette and the create popover)", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".topbar-new-btn")).toBeNull();
    expect(screen.queryByRole("button", { name: "Capture" })).toBeNull();
  });

  it("has no capture button in Chinese either", () => {
    act(() => setLocalePref("zh-TW"));
    renderTopbar();
    expect(screen.queryByRole("button", { name: "捕捉" })).toBeNull();
  });

  it("the quick-capture hotkey still dispatches the onden-open-quick-capture channel", () => {
    function Keys() {
      const noop = () => {};
      useKeyboardShortcuts({
        mode: "notes", notesView: "editor", selectedId: null, setSelectedId: noop,
        createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
        onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
        saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
        setFocusMode: noop,
      });
      return null;
    }
    render(<Keys />);
    const listener = vi.fn();
    window.addEventListener("onden-open-quick-capture", listener);
    try {
      fireEvent.keyDown(document.body, { key: "N", code: "KeyN", ctrlKey: true, metaKey: true, shiftKey: true });
    } finally { window.removeEventListener("onden-open-quick-capture", listener); }
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // D85: the hints read lib/shortcuts — the chord in effect, in this platform's
  // spelling — instead of hard-coded mac glyphs.
  it("shows the keys in effect on this device and follows a change", () => {
    try {
      renderTopbar();
      expect(document.querySelector(".palette-trigger kbd")).toHaveTextContent(formatChord("$mod+k"));
      if (!/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "")) {
        expect(document.querySelector(".palette-trigger kbd")).toHaveTextContent("Ctrl+K");
      }
      act(() => setShortcutChord("open-palette", "$mod+j"));
      expect(document.querySelector(".palette-trigger kbd")).toHaveTextContent(formatChord("$mod+j"));
    } finally {
      act(() => resetShortcuts());
    }
  });
});
