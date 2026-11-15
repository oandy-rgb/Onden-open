// @vitest-environment node
// Guard: the settings window has one size (docs/agents/decisions-ui.md). SettingsModal's shell owns the window's
// width/height and the content column's padding; a settings page (settings/**, a feature's settings CSS) must
// not size the shell or its own root, and the window has no size variant (only --phone, which is full screen).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");
const SHELL_OWNERS = ["settings/SettingsModal.css", "styles/global.css"];
const SHELL = /\.settings-(modal|content|body|overlay)\b/;
const PAGE_ROOT = /\.settings-(section|setting)\b(?![-\w])/;
const SIZING = /(^|[;{\s])(max-width|min-width|width|padding(-left|-right|-inline)?)\s*:/;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}
/** [selector, body] of every simple rule (media queries are walked into). */
function rules(css: string): Array<[string, string]> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(text.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g), (m) => [m[1].trim(), m[2]] as [string, string]);
}
const all = cssFiles(SRC).map((file) => ({ rel: relative(SRC, file), css: readFileSync(file, "utf8") }));
const pageFiles = all.filter(({ rel }) => rel.startsWith("settings/") || /modules\/.*[sS]etting[^/]*\.css$/.test(rel));

describe("settings pages do not size the window or their own root", () => {
  it("only SettingsModal.css and global.css write rules for the shell classes", () => {
    const offenders = all.filter(({ rel }) => !SHELL_OWNERS.includes(rel))
      .flatMap(({ rel, css }) => rules(css).filter(([sel]) => SHELL.test(sel)).map(([sel]) => `${rel}: ${sel}`));
    expect(offenders, "a page must not style the settings window; ask the shell (SettingsModal.css)").toEqual([]);
  });
  it("a page's root (.settings-section, .settings-setting) sets no width or padding", () => {
    const offenders = pageFiles.concat(all.filter(({ rel }) => SHELL_OWNERS.includes(rel)))
      .flatMap(({ rel, css }) => rules(css).filter(([sel, body]) => PAGE_ROOT.test(sel) && SIZING.test(body)).map(([sel]) => `${rel}: ${sel}`));
    expect(offenders).toEqual([]);
  });
  it("the window has no size variant: the only .settings-modal modifier is --phone", () => {
    const modifiers = new Set(all.flatMap(({ css }) => Array.from(css.matchAll(/\.settings-modal--([\w-]+)/g), (m) => m[1])));
    expect(Array.from(modifiers)).toEqual(["phone"]);
  });
  it("the desktop window is a fixed height, not a max-height that follows the page", () => {
    const base = rules(all.find(({ rel }) => rel === "styles/global.css")!.css).find(([sel]) => sel === ".settings-modal")![1];
    expect(base).toMatch(/\bwidth:\s*min\(/);
    expect(base).toMatch(/(^|[;\s])height:\s*min\(/);
    expect(base).not.toMatch(/max-height/);
  });
});
