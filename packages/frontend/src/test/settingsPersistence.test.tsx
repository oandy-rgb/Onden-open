// @vitest-environment jsdom
// Settings persistence (unification audit W12): saving and applying are
// separate, one useOption + codec reads and writes every value setting, boot
// replays through the same codec, and blocked storage never breaks a screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readValue, useOption } from "../settings/useOption";
import { SETTINGS, applyPersistedSettings } from "../settings/registry";
import SettingsModal from "../settings/SettingsModal";
import type { EnumSettingDef } from "../lib/settingsTypes";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));

const textSize = SETTINGS.find((d) => d.id === "note.text_size") as EnumSettingDef;

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("useOption", () => {
  it("stores through the codec and runs the side effect", () => {
    const { result } = renderHook(() => useOption(textSize));
    act(() => result.current[1]("xl"));
    expect(result.current[0]).toBe("xl");
    expect(localStorage.getItem("note.text_size")).toBe("xl");
    expect(document.documentElement.style.getPropertyValue("--onden-note-text-scale")).toBe("1.3");
  });

  it("falls back to the default for a value its codec cannot read", () => {
    localStorage.setItem("note.text_size", "huge");
    localStorage.setItem("note.text_scale", "abc");
    expect(readValue(textSize)).toBe("m");
  });

  it("theme mode lives under its storage key \"theme\"", () => {
    const mode = SETTINGS.find((d) => d.id === "theme.mode") as EnumSettingDef;
    localStorage.setItem("theme", "dark");
    expect(readValue(mode)).toBe("dark");
  });
});

describe("boot replay", () => {
  it("applies stored values without writing anything back", () => {
    localStorage.setItem("theme.ui_size", "large");
    const write = vi.spyOn(Storage.prototype, "setItem");
    applyPersistedSettings();
    expect(document.documentElement.getAttribute("data-density")).toBe("spacious");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("blocked storage", () => {
  it("the settings screen still renders, with defaults, and a change still applies", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(() => applyPersistedSettings()).not.toThrow();
    render(<SettingsModal online={false} onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Date and time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Notes/ }));
    expect(screen.getByRole("slider", { name: "Text size" })).toBeInTheDocument();
    const { result } = renderHook(() => useOption(textSize));
    expect(result.current[0]).toBe("m");
    act(() => result.current[1]("xs"));
    expect(result.current[0]).toBe("xs");
    expect(document.documentElement.style.getPropertyValue("--onden-note-text-scale")).toBe("0.8");
  });
});
