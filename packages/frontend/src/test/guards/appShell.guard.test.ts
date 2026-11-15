// The <head> of the app's three shells comes from one source, src/appShell/head.ts (owner 2026-11-09). #1400 put
// `interactive-widget=resizes-content` in index.html only, so the phone never got it until #1412; a hand-written copy
// in a shell is how that happens again. The shells only say where the head goes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HEAD_PLACEHOLDER, APP_SHELLS, appHeadEntries, renderAppHead, viewportContent, type AppShell } from "../../appShell/head";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => readFileSync(join(FRONTEND, file), "utf8");
const HAND_WRITTEN = /<meta\s+(?:charset|name="(?:viewport|description|theme-color|mobile-web-app-capable|apple-[a-z-]+)")|<link\s[^>]*rel="(?:icon|manifest|apple-touch-icon|shortcut icon)"|<title>/;

describe("the shells do not write the shared head", () => {
  for (const shell of ["index.html", "browser.html"]) {
    it(`${shell} only has the placeholder`, () => {
      const html = read(shell);
      expect(html).toContain(APP_HEAD_PLACEHOLDER);
      expect(HAND_WRITTEN.exec(html)?.[0], `${shell}: write it in src/appShell/head.ts`).toBeUndefined();
    });
  }
  it("pages/index.astro renders <AppHead /> and writes none of it", () => {
    const astro = read("src/pages/index.astro");
    expect(astro).toContain("<AppHead />");
    expect(HAND_WRITTEN.exec(astro)?.[0], "pages/index.astro: write it in src/appShell/head.ts").toBeUndefined();
  });
  it("the Vite configs of the two plain shells use the plugin that fills the placeholder", () => {
    expect(read("vite.capacitor.config.ts")).toContain('appHeadPlugin("capacitor")');
    expect(read("vite.browser.config.ts")).toContain('appHeadPlugin("browser")');
  });
});

describe("the head source", () => {
  const shells = Object.keys(APP_SHELLS) as AppShell[];
  for (const shell of shells) {
    it(`${shell}: the viewport has interactive-widget=resizes-content`, () => {
      expect(viewportContent(shell).split(",").map((p) => p.trim())).toContain("interactive-widget=resizes-content");
      const meta = appHeadEntries(shell, "#fff").find((e) => e.tag === "meta" && e.attrs.name === "viewport");
      expect(meta).toBeDefined();
      expect(renderAppHead(shell, "#fff")).toContain("interactive-widget=resizes-content");
    });
  }
  it("a shell that wants theme-color must be given its colour", () => {
    expect(() => appHeadEntries("web")).toThrow();
  });
});
