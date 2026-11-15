import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccountStorage } from "../lib/accountStorage";
import { applyFontVars, readFontStacks } from "../lib/fontStacks";
import { cleanFontName, fontsPref, parseFontChoices } from "../lib/fontPrefs";
import { applyFontChoices, fontStack, isMissingHere } from "../lib/fontApply";
import { hasFont, installedFonts } from "../lib/localFonts";
import { PREFS, setPref, settingPref } from "../lib/prefs";
import { applyPersistedSettings } from "../settings/appearance";
import { reads, sendWrite } from "../lib/data";
import LocalFontSetting from "../settings/LocalFontSetting";
import NoteFontCards from "../settings/NoteFontCards";

vi.mock("../lib/data", async (orig) => {
  const actual = await orig<typeof import("../lib/data")>();
  return {
    ...actual,
    sendWrite: vi.fn(async () => undefined),
    reads: { ...actual.reads, people: { ...actual.reads.people, myPref: vi.fn(async () => ({ value: null })) } },
  };
});

bindAccountStorage("fonts-user", "http://localhost");

const root = () => document.documentElement.style;
const has = (names: string[]) => (name: string) => names.includes(name);

// jsdom has no canvas: a stand-in whose text is wider only in a family named "Installed Face".
function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => {
    let font = "";
    return { set font(v: string) { font = v; }, measureText: () => ({ width: font.includes('"Installed Face"') ? 500 : font.includes("monospace") ? 300 : 320 }) };
  }) as never);
}

beforeEach(() => { stubCanvas(); localStorage.clear(); root().cssText = ""; fontsPref.store.forget(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as { queryLocalFonts?: unknown }).queryLocalFonts; });

describe("the three choices become the right stacks", () => {
  it("default is the built-in face (null); the system choice lists the device's faces then the app's Chinese-capable ones", () => {
    expect(fontStack("ui", { mode: "default" })).toBeNull();
    const system = fontStack("ui", { mode: "system" })!;
    expect(system.startsWith("system-ui")).toBe(true);
    expect(system.endsWith("var(--ac-font-sans)")).toBe(true);
    expect(fontStack("body", { mode: "system" })!.endsWith("var(--ac-font-serif)")).toBe(true);
  });

  it("a custom family comes first and the default Chinese face follows, for the interface and for note text", () => {
    const installed = has(["Mono Face"]);
    expect(fontStack("ui", { mode: "custom", name: "Mono Face" }, installed)).toBe('"Mono Face", var(--ac-font-sans)');
    expect(fontStack("body", { mode: "custom", name: "Mono Face" }, installed)).toBe('"Mono Face", var(--ac-font-serif)');
  });

  it("a family typed with quotes or CSS punctuation cannot break out of the list", () => {
    expect(cleanFontName('Evil"; } body { x:')).toBe("Evil body x:");
    expect(cleanFontName("  A \n B  ")).toBe("A B");
    expect(parseFontChoices({ ui: { mode: "custom", name: 'a"b' }, body: { mode: "default" } })).toEqual({ ui: { mode: "custom", name: "ab" }, body: { mode: "default" } });
    expect(parseFontChoices({ ui: { mode: "upload" }, body: { mode: "default" } })).toBeNull();
  });
});

describe("a device without the font", () => {
  it("falls back to the built-in face and says so", () => {
    const pick = { mode: "custom", name: "Not Here" } as const;
    expect(fontStack("ui", pick, has([]))).toBeNull();
    expect(isMissingHere(pick, has([]))).toBe(true);
    expect(isMissingHere(pick, has(["Not Here"]))).toBe(false);
    expect(isMissingHere({ mode: "system" }, has([]))).toBe(false);
  });

  it("hasFont tells an installed family by its width against two fallbacks, and answers true where it cannot measure", () => {
    const measure = (font: string) => (font.includes('"Here"') ? 500 : font.includes("monospace") ? 300 : 320);
    expect(hasFont("Here", measure)).toBe(true);
    expect(hasFont("Nope", (font) => (font.includes("monospace") ? 300 : 320))).toBe(false);
    expect(hasFont("Anything", null)).toBe(true);
    expect(hasFont("  ", measure)).toBe(false);
  });
});

describe("the page variables", () => {
  it("default leaves the interface variable unset and the note font follows 「字體」, kai and monospace with a Chinese face behind", () => {
    applyFontVars();
    expect(root().getPropertyValue("--onden-ui-font-family-ui")).toBe("");
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toBe("var(--ac-font-serif)");
    setPref(settingPref("theme.editor_font"), "mono"); // the older 「編輯器字體」 still counts until 「字體」 is chosen
    applyFontVars();
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toBe("var(--ac-font-mono), var(--ac-font-sans)");
    setPref(settingPref("note.font"), "kai");
    applyFontVars();
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toBe("var(--ac-font-kai), var(--ac-font-serif)");
  });

  it("the interface follows the system whatever the old 介面字型 choice was; note text keeps the system choice and boot replays it", () => {
    applyFontChoices({ ui: { mode: "system" }, body: { mode: "system" } });
    expect(root().getPropertyValue("--onden-ui-font-family-ui")).toBe("");
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toContain("system-ui");
    root().cssText = "";
    applyPersistedSettings();
    expect(root().getPropertyValue("--onden-ui-font-family-ui")).toBe("");
    expect(readFontStacks().body).toContain("system-ui");
  });

  it("a custom family this device lacks is applied as the default; back to default clears it", () => {
    applyFontChoices({ ui: { mode: "custom", name: "Not Here" }, body: { mode: "custom", name: "Not Here" } });
    expect(root().getPropertyValue("--onden-ui-font-family-ui")).toBe("");
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toBe("var(--ac-font-serif)");
    applyFontChoices(null);
    expect(root().getPropertyValue("--onden-ui-font-family-ui")).toBe("");
    expect(PREFS.fontStacks.scope).toBe("device");
  });
});

describe("Local Font Access", () => {
  it("lists installed families once each, sorted", async () => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => [{ family: "B" }, { family: "A" }, { family: "B" }]);
    expect(await installedFonts()).toEqual(["A", "B"]);
  });

  it("is null when the browser lacks it or the person declines", async () => {
    expect(await installedFonts()).toBeNull();
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => { throw new Error("denied"); });
    expect(await installedFonts()).toBeNull();
  });
});

describe("Settings › Notes › 字體", () => {
  it("shows one card per built-in face, each written in its own face, and choosing one applies it", async () => {
    render(<NoteFontCards />);
    const cards = screen.getAllByRole("radio");
    expect(cards.map((c) => c.getAttribute("data-value"))).toEqual(["sans", "serif", "kai", "mono"]);
    expect(cards[2]!.querySelector<HTMLElement>(".ui-choice-sample")!.style.getPropertyValue("--choice-sample-font")).toContain("--ac-font-kai");
    expect(cards[1]!.getAttribute("aria-checked")).toBe("true"); // serif is the default
    fireEvent.click(cards[2]!);
    await waitFor(() => expect(screen.getAllByRole("radio")[2]!.getAttribute("aria-checked")).toBe("true"));
    expect(localStorage.getItem("note.font")).toBe("kai");
    expect(root().getPropertyValue("--onden-ui-font-family-editor")).toContain("--ac-font-kai");
  });

  it("a font from this computer is a fifth card, and choosing a built-in card clears it so the two never cover each other", async () => {
    await act(async () => { fontsPref.store.save({ ui: { mode: "default" }, body: { mode: "custom", name: "Installed Face" } }); });
    render(<NoteFontCards />);
    const cards = screen.getAllByRole("radio");
    expect(cards).toHaveLength(5);
    expect(cards[4]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(cards[0]!);
    await waitFor(() => expect(fontsPref.store.get().value?.body).toEqual({ mode: "default" }));
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("without Local Font Access the other-fonts button shows only the text box", async () => {
    render(<LocalFontSetting />);
    fireEvent.click(screen.getByText("Other fonts on this computer…"));
    expect(await screen.findByLabelText("Font name")).toBeTruthy();
    expect(screen.queryByText("Pick from installed fonts")).toBeNull();
  });

  it("with Local Font Access it offers the list, and picking saves the family to the account", async () => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => [{ family: "Alpha" }, { family: "Beta" }]);
    render(<LocalFontSetting />);
    fireEvent.click(screen.getByText("Other fonts on this computer…"));
    fireEvent.click(await screen.findByText("Pick from installed fonts"));
    const list = await screen.findByLabelText("Installed fonts");
    fireEvent.change(list, { target: { value: "Beta" } });
    await waitFor(() => expect(fontsPref.store.get().value?.body).toEqual({ mode: "custom", name: "Beta" }));
    expect(vi.mocked(sendWrite)).toHaveBeenCalledWith("PUT", "/api/me/prefs/fonts", expect.objectContaining({ value: expect.objectContaining({ body: { mode: "custom", name: "Beta" } }) }));
  });

  it("says plainly when this device lacks the font, with no CSS or ids", async () => {
    await act(async () => { fontsPref.store.save({ ui: { mode: "default" }, body: { mode: "custom", name: "Not Here" } }); });
    render(<LocalFontSetting />);
    expect(await screen.findByText("This device doesn't have this font, so it's using the default font.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/var\(--|font-family/);
  });

  it("adopts the account's choice from the server", async () => {
    vi.mocked(reads.people.myPref).mockResolvedValueOnce({ value: { ui: { mode: "system" }, body: { mode: "default" } } } as never);
    await fontsPref.store.sync();
    expect(fontsPref.store.get().value?.ui).toEqual({ mode: "system" });
  });
});

describe("Settings › Notes › 字體: choosing a card while a computer font is set", () => {
  it("does not bring the computer font back when the typed name is only left over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => { fontsPref.store.save({ ui: { mode: "default" }, body: { mode: "custom", name: "Installed Face" } }); });
      render(<><NoteFontCards /><LocalFontSetting /></>);
      expect(screen.getByLabelText("Font name")).toHaveValue("Installed Face");
      fireEvent.click(screen.getAllByRole("radio")[2]!); // 楷體
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fontsPref.store.get().value?.body).toEqual({ mode: "default" });
      expect(localStorage.getItem("note.font")).toBe("kai");
    } finally { vi.useRealTimers(); }
  });

  it("shows the older 「跟系統一樣」 body font as its own chosen card, and a built-in card replaces it", async () => {
    await act(async () => { fontsPref.store.save({ ui: { mode: "default" }, body: { mode: "system" } }); });
    render(<NoteFontCards />);
    const cards = screen.getAllByRole("radio");
    expect(cards).toHaveLength(5);
    expect(cards[4]!.textContent).toContain("Same as the system");
    expect(cards.filter((c) => c.getAttribute("aria-checked") === "true")).toEqual([cards[4]]);
    fireEvent.click(cards[0]!);
    await waitFor(() => expect(fontsPref.store.get().value?.body).toEqual({ mode: "default" }));
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });
});
