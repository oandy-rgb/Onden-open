// A module screen, a note's view tab, and the three panes of the notes page each have their own error boundary
// (components/RegionErrorBoundary), so one throwing render no longer replaces the whole app with AppErrorBoundary's
// page. The seams are single places: SecondaryLensOutlet mounts every module screen and the reading hub,
// OwnerViewPane every saved-view tab (module panes included), NotesWorkspace the sidebar, center and inspector.
// A module is not wrapped one by one: a new module screen goes through the same outlet and is covered.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const regions = (source: string) => [...source.matchAll(/<RegionErrorBoundary\s+region=/g)].length;

describe("every module seam goes through RegionErrorBoundary", () => {
  it("SecondaryLensOutlet wraps what it renders for every module screen", () => {
    const source = read("components/SecondaryLensOutlet.tsx");
    expect(source).toContain('import RegionErrorBoundary from "./RegionErrorBoundary"');
    expect(source).toMatch(/<RegionErrorBoundary[^>]*>\{lenses\[mode\]\?\.\(\) \?\? null\}<\/RegionErrorBoundary>/);
  });
  it("OwnerViewPane wraps a module's note view pane and the collection view", () => {
    const source = read("components/viewTabs/OwnerViewPane.tsx");
    expect(regions(source)).toBe(2);
    expect(source).toMatch(/<RegionErrorBoundary[^>]*>\s*<Suspense[^>]*><Pane /);
    expect(source).toMatch(/<RegionErrorBoundary[^>]*>\s*<Suspense[^>]*>\s*<CollectionView /);
  });
  it("NotesWorkspace keeps sidebar, center and inspector apart", () => {
    const source = read("components/workspace/NotesWorkspace.tsx");
    for (const slot of ["sidebar", "center", "inspector"]) {
      expect(source, slot).toMatch(new RegExp(`<RegionErrorBoundary[^>]*region="${slot}"[^>]*>\\{${slot}\\}</RegionErrorBoundary>`));
    }
  });
  it("the last-resort AppErrorBoundary stays around the whole app", () => {
    expect(read("AppRoot.tsx")).toMatch(/<AppErrorBoundary>\s*<BuilderApp \/>\s*<\/AppErrorBoundary>/);
  });
});
