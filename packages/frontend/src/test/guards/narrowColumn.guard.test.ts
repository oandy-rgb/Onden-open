// The note column can be about 435px wide (a tablet with the notes list and the info pane both open). Three things broke
// there on the owner's Galaxy Tab S9 (2026-11-17); each is a rule about who owns a style, so each is checked at the source:
//   · the tab strip's 「＋」 is not part of what scrolls (the list scrolls, 「＋」 stays);
//   · what a panel looks like ships with the component that draws it (the add-view panel's rules sat in the stylesheet of a
//     view that loads later, so the first panel opened 66px wide);
//   · a pane lays out from its own width (a container query), so two columns beside each other each choose for themselves.
// The measured version is e2e/browser-app/tabletViews.mjs (real Chromium at 1204×714, touch).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string | null {
  const text = noComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(text)?.[1] ?? null;
}

describe("the view tab strip in a narrow column", () => {
  const css = read("components/viewTabs/ViewTabs.css");
  it("the tab list scrolls and the row around it, with ＋, does not", () => {
    expect(rule(css, ".view-tabs")).not.toMatch(/overflow/);
    expect(rule(css, ".view-tabs-list")).toMatch(/overflow-x:\s*auto/);
    expect(rule(css, ".view-tabs > .view-tab--add")).toMatch(/flex:\s*none/);
  });
  it("a list that can scroll shows it (the strip fades its ends)", () => {
    expect(rule(css, ".center-lens-bar .view-tabs-list")).toMatch(/linear-gradient/);
  });
});

describe("a panel's rules load with the panel", () => {
  it("every cv-add-view class the chooser draws is defined in a stylesheet the chooser imports itself", () => {
    const chooser = read("components/collections/LayoutChooser.tsx");
    const imported = [...chooser.matchAll(/import\s+"\.\/([^"]+\.css)"/g)].map((m) => read(`components/collections/${m[1]}`)).join("\n");
    const used = new Set([
      ...[...chooser.matchAll(/cv-add-view[\w-]*/g)].map((m) => m[0]),
      ...[...read("components/viewTabs/AddViewPanel.tsx").matchAll(/cv-add-view[\w-]*/g)].map((m) => m[0]),
    ]);
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((name) => !new RegExp(`\\.${name}\\b`).test(imported));
    expect(missing).toEqual([]);
    expect(rule(imported, ".cv-add-view-panel")).toMatch(/min-width:\s*220px/);
  });
  it("the stylesheet of a view that loads later does not also define them", () => {
    expect(noComments(read("components/collections/CollectionView.css"))).not.toMatch(/\.cv-add-view/);
  });
});

describe("the slides tab lays out from its own width", () => {
  const css = read("modules/slides/slidesPane.css");
  const text = noComments(css);
  it("it is a container, and its narrow layout is a container query, not a window one", () => {
    expect(rule(css, ".sp")).toMatch(/container:\s*sp\s*\/\s*inline-size/);
    expect(text).toMatch(/@container sp \(max-width:\s*\d+px\)/);
    expect(text).not.toMatch(/@media\s*\(max-width/);
  });
  it("the 換成… list there is an opaque panel in the column, not a column of the grid", () => {
    const narrow = /@container sp[^{]*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    expect(narrow).toMatch(/\.sp-main,\s*\.sp-main\.has-replace\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const panel = /\.sp-replace\s*\{([^}]*)\}/.exec(narrow)?.[1] ?? "";
    expect(panel).toMatch(/background:\s*var\(--ac-elevated\)/);
    expect(panel).toMatch(/position:\s*sticky/);
  });
});

describe("the board's selected-card bar", () => {
  it("is docked, not placed over the card it belongs to (it covered the cards above it)", () => {
    const workspace = read("components/KnowledgeWorkspace.tsx");
    expect(workspace).not.toMatch(/NodeToolbar/);
    expect(rule(read("components/BoardSelectionBar.css"), ".board-selection-dock")).toMatch(/position:\s*absolute/);
  });
});
