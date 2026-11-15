import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import IndexPage from "../src/pages/index.astro";
import { THEME_COLORS } from "../src/settings/themeColor";

// R24: the boot script in index.astro (no-flash theme) and applyThemeMode
// (settings/registry.tsx) must paint the same <meta name="theme-color">. Both
// read THEME_COLORS; this renders the page and runs its boot script against a
// stub document to pin what the script actually writes.

// The page mounts <AppRoot client:only="react">: nothing is server-rendered
// with React, but Astro still wants a renderer of that name, so a stub stands in.
async function renderPage(): Promise<string> {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    name: "@astrojs/react",
    renderer: {
      name: "@astrojs/react",
      check: async () => false,
      renderToStaticMarkup: async () => ({ html: "" }),
    },
  });
  container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
  return container.renderToString(IndexPage);
}

async function bootScript(): Promise<string> {
  const html = await renderPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const boot = scripts.find((s) => s.includes("data-theme"));
  expect(boot, "boot script not found").toBeDefined();
  return boot!;
}

function run(script: string, stored: string | null, osDark: boolean) {
  const attrs: Record<string, string> = {};
  const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
  runInNewContext(script, {
    localStorage: { getItem: () => stored },
    window: { matchMedia: () => ({ matches: osDark }) },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      querySelector: () => meta,
    },
  });
  return { theme: attrs["data-theme"], color: meta.content };
}

describe("index.astro boot script uses THEME_COLORS", () => {
  it("static meta is the light colour", async () => {
    const html = await renderPage();
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLORS.light}"`);
  });

  it("writes the same colours applyThemeMode does", async () => {
    const script = await bootScript();
    expect(run(script, "dark", false)).toEqual({ theme: "dark", color: THEME_COLORS.dark });
    expect(run(script, "light", true)).toEqual({ theme: "light", color: THEME_COLORS.light });
    expect(run(script, null, true)).toEqual({ theme: "dark", color: THEME_COLORS.dark });
    expect(run(script, "system", false)).toEqual({ theme: "light", color: THEME_COLORS.light });
  });
});
