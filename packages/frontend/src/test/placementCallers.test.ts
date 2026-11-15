// D101: every surface that decides where a note may go asks the one rule in
// lib/data/placement.ts (canPlaceUnder / placementCandidates /
// placementRefusal). Before it, five surfaces each rolled their own: a
// descendant walk in the sidebar drag, getSubtreeIds + a tag filter in the
// picker, window.prompt in the pin flow, nothing at all on a board's parent
// arrow. This keeps them from drifting apart again; the behaviour itself is
// tested in placement.test.ts and each surface's own test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const CALLERS: Record<string, RegExp> = {
  "components/ParentCombobox.tsx": /\bplacementCandidates\(/,
  "hooks/useSidebarDrag.ts": /\bcanPlaceUnder\(/,
  "hooks/useBoardWorkspace.ts": /\bplacementRefusal\(/,
  "modules/capture/QuickCapture.tsx": /\bcanPlaceUnder\(/,
};

// Hand-rolled placement: a private descendant walk or subtree exclusion, or
// asking for a parent by typed title.
const HAND_ROLLED = /\b(isDescendantNode|getSubtreeIds|subtreeIdsOf)\b|window\.prompt\(/;

describe("placement callers (D101)", () => {
  it.each(Object.entries(CALLERS))("%s asks lib/data placement", (file, call) => {
    const text = readFileSync(join(src, file), "utf8");
    expect(text).toMatch(call);
    expect(text).not.toMatch(HAND_ROLLED);
  });

  it("the pin flow picks its parent in the pin picker, not a prompt", () => {
    const read = (file: string) => readFileSync(join(src, file), "utf8");
    expect(read("components/ParentCombobox.tsx")).toMatch(/const pin = variant === "pin"/);
    expect(read("components/ContextMenu.tsx")).toMatch(/<MoveToDialog purpose="pin"/);
    expect(read("hooks/useNodeCreation.ts")).not.toMatch(/Pin under which note/);
  });
});
