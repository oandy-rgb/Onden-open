import { describe, it, expect } from "vitest";
import {
  INTRO_PAGES,
  INTRO_HOME_TITLE,
  INTRO_SITE_CONFIG,
} from "../data/introSite";

// introSite.ts is the SINGLE source of truth for the dogfood site — consumed by
// both the fullstack screenshot spec and the first-run "Explore the Onden intro"
// install. These guard the content shape both consumers depend on.

describe("introSite content module", () => {
  it("ships exactly the six intro pages, in nav order, titled", () => {
    expect(INTRO_PAGES).toHaveLength(6);
    expect(INTRO_PAGES.map((p) => p.title)).toEqual([
      "Home",
      "The idea",
      "What you can do",
      "Why local-first",
      "Get started",
      "Colophon",
    ]);
  });

  it("every page has a non-empty title + markdown body", () => {
    for (const p of INTRO_PAGES) {
      expect(p.title.trim().length).toBeGreaterThan(0);
      expect(p.markdown.trim().length).toBeGreaterThan(0);
      expect(typeof p.nav).toBe("boolean");
    }
  });

  it("five pages are in the top nav; Colophon is a linked/footer page only", () => {
    const navTitles = INTRO_PAGES.filter((p) => p.nav).map((p) => p.title);
    expect(navTitles).toHaveLength(5);
    expect(navTitles).not.toContain("Colophon");
    expect(INTRO_PAGES.find((p) => p.title === "Colophon")?.nav).toBe(false);
  });

  it("the home title points at a real page (focused after install)", () => {
    expect(INTRO_PAGES.some((p) => p.title === INTRO_HOME_TITLE)).toBe(true);
  });

  it("wikilinks resolve: every [[Target]] names an existing page title", () => {
    const titles = new Set(INTRO_PAGES.map((p) => p.title));
    for (const p of INTRO_PAGES) {
      for (const m of p.markdown.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = m[1].split("|")[0].trim();
        expect(titles.has(target), `[[${target}]] in "${p.title}"`).toBe(true);
      }
    }
  });

  it("config names the site and carries the Gallery accent and SEO text", () => {
    expect(INTRO_SITE_CONFIG.brand).toBe("Onden");
    expect(INTRO_SITE_CONFIG.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof INTRO_SITE_CONFIG.description).toBe("string");
    expect(INTRO_SITE_CONFIG.description.length).toBeGreaterThan(0);
  });
});
