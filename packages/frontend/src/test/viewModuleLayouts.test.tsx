// A view module carries its own layout: CollectionView draws a saved view by
// looking its module up in VIEW_MODULES, and no core file lists the layouts, so
// a new layout is a module directory plus its line in modules/index.ts.
import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLayout } from "../components/collections/CollectionView";
import { type ExecResponse } from "../lib/viewExec";
import { VIEW_MODULES } from "../modules";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const exec: ExecResponse = { rows: [], next: null, view: { layout: "table", group_by: null } } as unknown as ExecResponse;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "modules" || name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Lines that quote at least three of `ids` — a list of layouts. */
const layoutLists = (text: string, ids: string[]) =>
  text.split("\n").filter((line) => ids.filter((id) => new RegExp(`["']${id}["']`).test(line)).length >= 3);

describe("view module layouts", () => {
  it("every view module brings the Layout that draws it", () => {
    expect(VIEW_MODULES.map((mod) => mod.id)).toEqual(["table", "calendar", "kanban", "gallery"]);
    for (const mod of VIEW_MODULES) {
      const drawn = renderLayout(mod.id, exec, { viewId: "v1" });
      expect(isValidElement(drawn), mod.id).toBe(true);
      // The layout loads on use, so it is drawn inside a Suspense (renderLayout).
      expect((drawn as { props: { children: { type: unknown } } }).props.children.type, mod.id).toBe(mod.view.Layout);
    }
  });

  it("a layout no module supplies says which layouts exist, from the modules", () => {
    const drawn = renderLayout("timeline", exec, { viewId: "v1" }) as { props: { title: string } };
    expect(String(drawn.props.title)).toContain("Switch to table, calendar, board, cards.");
  });

  it("no core file lists the layouts", () => {
    const ids = VIEW_MODULES.map((mod) => mod.id);
    const allowed = new Set(["lib/i18n.zh-TW.ts", "lib/i18n.ts"]);
    // The detector sees a list (this guards the scan below)…
    expect(layoutLists('type L = "table" | "kanban" | "calendar";', ids)).toHaveLength(1);
    expect(layoutLists('layout === "kanban" || layout === "table"', ids)).toHaveLength(0);
    // …and core has none.
    const offenders = sourceFiles(src).flatMap((file) => {
      const rel = relative(src, file);
      return allowed.has(rel) || /\.test\.tsx?$/.test(rel) ? [] : layoutLists(readFileSync(file, "utf8"), ids).map((line) => `${rel}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
