// The sidebar's ▸ column and its invisible tap reach are defined once (the touch rule in OverviewSidebar.css), not once per
// width level: two copies drifted apart (28/-14 vs 32/-12) and the reviewer had to ask which one covered the title's first letters.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/components/OverviewSidebar.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("sidebar ▸ toggle reach", () => {
  it("has one rule for the toggle column and one for its reach", () => {
    expect(css.match(/\.obsidian-group-toggle\s*\{/g) ?? []).toHaveLength(1);
    expect(css.match(/\.obsidian-group-toggle::after\s*\{/g) ?? []).toHaveLength(1);
  });
  it("that rule is the touch rule, not a window width", () => {
    const at = css.search(/\.obsidian-group-toggle::after\s*\{/);
    const media = [...css.slice(0, at).matchAll(/@media[^{]*\{/g)].pop()?.[0] ?? "";
    expect(media).toContain("pointer: coarse");
  });
});
