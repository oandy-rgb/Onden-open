import { describe, expect, it } from "vitest";
import { flattenSidebarTree, groupRootsBySpace } from "../lib/sidebarFlatten";
import type { ContentNode } from "../lib/api";

// A space just made has no notes. It must still be in the sidebar, with a way to start the first one.
describe("a space with no notes yet", () => {
  const sketch = { id: "a", title: "Sketch", space_id: "mine" } as ContentNode;
  const spaces = [{ id: "mine", label: "Only me" }, { id: "new", label: "Year 3" }, { id: "read", label: "Read only" }];

  it("keeps the spaces a note may be made in, and still drops the rest", () => {
    const groups = groupRootsBySpace([sketch], spaces, "Other", new Set(["mine", "new"]));
    expect(groups.map((g) => [g.label, g.roots.length])).toEqual([["Only me", 1], ["Year 3", 0]]);
  });

  it("without the list, an empty space is left out as before", () => {
    expect(groupRootsBySpace([sketch], spaces, "Other").map((g) => g.label)).toEqual(["Only me"]);
  });

  it("is a heading followed by an 'empty' row, so the list can draw 「還沒有筆記」 and the ＋", () => {
    const groups = groupRootsBySpace([sketch], spaces, "Other", new Set(["new"]));
    const rows = flattenSidebarTree([sketch], new Map(), new Map(), new Set(), groups);
    expect(rows.map((r) => r.kind === "space" ? `# ${r.label}` : r.kind === "spaceEmpty" ? `(empty ${r.spaceId})` : r.kind === "node" ? r.item.id : "p"))
      .toEqual(["# Only me", "a", "# Year 3", "(empty new)"]);
  });
});
