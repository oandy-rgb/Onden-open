import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyThemeMode } from "../settings/registry";
import { THEME_COLORS } from "../settings/themeColor";

// R24: the inline boot script in pages/index.astro used to be the only code
// that wrote <meta name="theme-color">, so a theme switch in Settings (or the
// OS flipping in "system" mode) left the status bar on the old colour until a
// reload. applyThemeMode now writes it too, from the same THEME_COLORS.

function metaContent(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null;
}

describe("applyThemeMode keeps theme-color in step", () => {
  beforeEach(() => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    applyThemeMode("light");
  });

  it("creates the meta tag when the page has none (Capacitor index.html)", () => {
    applyThemeMode("dark");
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(metaContent()).toBe(THEME_COLORS.dark);
  });

  it("updates the existing tag on an explicit switch", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = THEME_COLORS.light;
    document.head.appendChild(meta);

    applyThemeMode("dark");
    expect(metaContent()).toBe(THEME_COLORS.dark);
    applyThemeMode("light");
    expect(metaContent()).toBe(THEME_COLORS.light);
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });

  it("follows the OS scheme in system mode", () => {
    let listener: ((e: MediaQueryListEvent) => void) | null = null;
    const mql = {
      matches: false,
      addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listener = l; },
      removeEventListener: () => { listener = null; },
    };
    vi.stubGlobal("matchMedia", () => mql);

    applyThemeMode("system");
    expect(metaContent()).toBe(THEME_COLORS.light);

    expect(listener).not.toBeNull();
    listener!({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(metaContent()).toBe(THEME_COLORS.dark);
  });
});

describe("boot script and module share one colour source", () => {
  // vitest runs from the frontend package root (process.cwd()).
  const page = readFileSync(resolve(process.cwd(), "src/pages/index.astro"), "utf8");

  it("index.astro takes its colours from THEME_COLORS, not literals", () => {
    expect(page).toMatch(/import \{ THEME_COLORS \} from "\.\.\/settings\/themeColor"/);
    expect(page).toContain("define:vars={{ themeColors: THEME_COLORS }}");
    // The static light colour of the meta tag is rendered by appShell/AppHead.astro from the same constant.
    expect(readFileSync(resolve(process.cwd(), "src/appShell/AppHead.astro"), "utf8")).toContain("THEME_COLORS.light");
    for (const hex of Object.values(THEME_COLORS)) {
      expect(page.toLowerCase()).not.toContain(hex);
    }
  });

  it("THEME_COLORS is the page colour (--ac-bg) of each theme in tokens.css", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
    const bgIn = (selector: string) => {
      const block = tokens.slice(tokens.indexOf(selector));
      return /--ac-bg:\s*(#[0-9a-f]{6})/i.exec(block)?.[1].toLowerCase();
    };
    expect(bgIn(':root,\n[data-theme="light"]')).toBe(THEME_COLORS.light);
    expect(bgIn('[data-theme="dark"] {')).toBe(THEME_COLORS.dark);
  });

  it("the PWA manifest's theme_color is the light colour", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"),
    ) as { theme_color: string };
    expect(manifest.theme_color).toBe(THEME_COLORS.light);
  });
});
