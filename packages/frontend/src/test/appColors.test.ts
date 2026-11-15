// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { APP_TOKEN_NAMES, DEFAULT_APP_SEED, appTokens } from "@onden/site/palette";
import { applyStoredColors, COLORS_KEY, readStoredColors, saveColorSeed, storedColorBg } from "../lib/appColors";
import { chooseColors } from "../settings/appearance";
import { THEME_COLORS } from "../settings/themeColor";

// The default look lives twice: as hex in styles/tokens.css (so the first paint
// needs no JavaScript) and as the formula's output for the default seeds. They
// must be the same colours, in both themes.

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const darkAt = tokens.indexOf('[data-theme="dark"] {');
const blocks = { light: tokens.slice(0, darkAt), dark: tokens.slice(darkAt) };

function cssValues(block: string): Record<string, string> {
  return Object.fromEntries(APP_TOKEN_NAMES.map((name) => {
    const hex = new RegExp(`--ac-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1];
    return [name, hex?.toLowerCase() ?? `(missing --ac-${name})`];
  }));
}

describe("tokens.css holds the formula's default colours", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: every computed colour is what tokens.css says`, () => {
      expect(cssValues(blocks[mode])).toEqual(appTokens(DEFAULT_APP_SEED.accent, DEFAULT_APP_SEED.paper, mode));
    });
  }
  it("THEME_COLORS are the default page colours", () => {
    expect(THEME_COLORS.light).toBe(appTokens(DEFAULT_APP_SEED.accent, DEFAULT_APP_SEED.paper, "light").bg);
    expect(THEME_COLORS.dark).toBe(appTokens(DEFAULT_APP_SEED.accent, DEFAULT_APP_SEED.paper, "dark").bg);
  });
});

const GREEN = { accent: "#2f6b4f", paper: "#f3f2ea" };

function metaContent(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null;
}

describe("a chosen colour scheme", () => {
  beforeEach(() => { localStorage.clear(); document.head.innerHTML = ""; document.documentElement.removeAttribute("data-theme"); });
  afterEach(() => { localStorage.clear(); document.getElementById("onden-colors")?.remove(); });

  it("stores the computed CSS and page colours, and the default seed stores nothing", async () => {
    expect(await saveColorSeed(GREEN)).toBe(true);
    const stored = readStoredColors()!;
    expect(stored).toMatchObject(GREEN);
    expect(stored.bg).toEqual({ light: GREEN.paper, dark: appTokens(GREEN.accent, GREEN.paper, "dark").bg });
    expect(stored.css).toContain(`--ac-accent:${appTokens(GREEN.accent, GREEN.paper, "light").accent}`);
    await saveColorSeed(DEFAULT_APP_SEED);
    expect(localStorage.getItem(COLORS_KEY)).toBeNull();
  });

  it("puts one style element on the page, replaced by the next choice and removed by the default", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    await chooseColors(GREEN);
    await chooseColors({ accent: "#6a4c93", paper: "#f5f2f4" });
    const styles = document.querySelectorAll("#onden-colors");
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toContain(appTokens("#6a4c93", "#f5f2f4", "light").accent);
    await chooseColors(null);
    expect(document.getElementById("onden-colors")).toBeNull();
  });

  it("points the browser's theme colour at the chosen page colour, and back", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await chooseColors(GREEN);
    expect(metaContent()).toBe(storedColorBg("dark"));
    expect(metaContent()).not.toBe(THEME_COLORS.dark);
    await chooseColors(null);
    expect(metaContent()).toBe(THEME_COLORS.dark);
  });

  it("ignores a stored value that is unreadable or not a colour sheet", () => {
    for (const raw of ["nope", "{}", JSON.stringify({ ...GREEN, v: 1, css: "x{background:url(//evil)}", bg: { light: "#fff", dark: "#000" } })]) {
      localStorage.setItem(COLORS_KEY, raw);
      expect(readStoredColors(), raw).toBeNull();
      applyStoredColors();
      expect(document.getElementById("onden-colors")).toBeNull();
    }
  });

  it("reports a refused write instead of claiming the colours were kept", async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota"); };
    try { expect(await saveColorSeed(GREEN)).toBe(false); } finally { Storage.prototype.setItem = original; }
  });
});

describe("the boot script applies the stored colours before first paint", () => {
  const page = readFileSync(resolve(process.cwd(), "src/pages/index.astro"), "utf8");
  const script = /<script is:inline[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]!;

  function boot(stored: unknown, mode: "light" | "dark") {
    const appended: Array<{ id: string; textContent: string }> = [];
    const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
    runInNewContext(script, {
      themeColors: THEME_COLORS,
      localStorage: { getItem: (k: string) => (k === "theme" ? mode : k === COLORS_KEY && stored ? JSON.stringify(stored) : null) },
      window: { matchMedia: () => ({ matches: false }) },
      document: {
        documentElement: { setAttribute: () => undefined },
        querySelector: () => meta,
        createElement: () => ({ id: "", textContent: "" }),
        head: { appendChild: (el: { id: string; textContent: string }) => appended.push(el) },
      },
    });
    return { styles: appended, color: meta.content };
  }

  it("injects the stored CSS and uses its page colour for the theme colour", async () => {
    await saveColorSeed(GREEN);
    const stored = readStoredColors()!;
    expect(boot(stored, "dark")).toEqual({ styles: [{ id: "onden-colors", textContent: stored.css }], color: stored.bg.dark });
    expect(boot(stored, "light").color).toBe(GREEN.paper);
  });

  it("leaves the defaults alone when nothing is stored", () => {
    expect(boot(null, "dark")).toEqual({ styles: [], color: THEME_COLORS.dark });
  });
});
