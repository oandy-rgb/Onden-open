import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import SettingsModal from "../settings/SettingsModal";
import { applyThemeMode } from "../settings/registry";

// MB5: SettingsModal used to run a leftover BINARY theme effect on mount
// (localStorage.theme==='dark' ? dark : light) — but "theme" stores a 3-way
// MODE now, so with OS-dark + mode=system, opening Settings flipped the app
// to light. The modal must not touch data-theme at all; boot replay
// (AppRoot → applyPersistedSettings) owns it.

describe("SettingsModal never overrides the resolved theme (MB5)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("mode=system with a dark resolution survives opening Settings", () => {
    window.localStorage.setItem("theme", "system");
    // Simulate the boot-time resolution having landed on dark (OS dark).
    document.documentElement.setAttribute("data-theme", "dark");

    render(
      <SettingsModal online onClose={() => {}} onImportDone={() => {}} onConnect={() => {}} />,
    );

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("registry applyThemeMode still pins explicit modes", () => {
    applyThemeMode("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyThemeMode("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
