// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ModuleNotImported from "../components/ModuleNotImported";
import { AppNavigation } from "../components/AppTopbar";
import { resetAppState, setAppState } from "../lib/appStore";

// Modules are imported in one place, Settings › Modules (the module library).
// Everywhere else that meets a module the workspace has not imported points
// there instead of importing it: no topbar 「＋ 功能」, no first-run picker, no
// import button on a not-imported page, no import actions in ⌘K.

function withWorkspace(modules: string[], owner = true) {
  resetAppState();
  setAppState((s) => ({ online: true, data: { ...s.data, actor_role: owner ? "admin" : "editor", actor_is_owner: owner, workspace: { ...s.data.workspace, modules } } }));
}

afterEach(() => resetAppState());

describe("importing modules happens only in Settings › Modules", () => {
  it("a not-imported module page sends the owner and everyone else to the module library", () => {
    for (const owner of [true, false]) {
      withWorkspace([], owner);
      const opened = vi.fn();
      window.addEventListener("onden:open-settings", opened);
      const { unmount } = render(<ModuleNotImported moduleId="rss" />);
      expect(screen.queryByRole("button", { name: /import/i })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open the module library" }));
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toBe("modules");
      window.removeEventListener("onden:open-settings", opened);
      unmount();
    }
  });

  it("the desktop navigation has no 「＋ 功能」 menu, even for the owner with modules left to import", () => {
    withWorkspace([]);
    render(<AppNavigation mode="notes" setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /add features|功能/i })).toBeNull();
  });
});
