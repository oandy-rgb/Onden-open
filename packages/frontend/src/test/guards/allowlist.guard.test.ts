// @vitest-environment node
// Guard: allowlists, not blocklists. Each rule names who MAY use a thing (owners.ts); every other
// file is a violation. Today's violations are counted per file in scripts/allowlist-baseline.json and
// may only shrink: a higher count or a new file fails with "this file may not use X, use <owner>";
// a lower count passes and prints that the baseline can be lowered (npm run allowlist:baseline).
// Detectors are in allowlist/detect.ts and allowlist/css.ts, the per-file rule table in allowlist/fileRules.ts
// (shared with scripts/checkEditedFile.mjs); allowlistRules.guard.test.ts feeds the detectors samples.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRule } from "../../../../../scripts/allowlistLib.mjs";
import { SRC, sourceFiles } from "./sources";
import { cssFiles } from "./allowlist/cssFiles";
import { legacyTokenUses, definedProperties } from "./allowlist/css";
import { frontendViolations, RULE_META } from "./allowlist/fileRules";
import { CSS_EXEMPT, inOwners, TOKEN_DEFINITION_EXEMPT, TOKEN_PREFIX_OWNERS } from "./allowlist/owners";

const countsByRule = new Map<string, Record<string, number>>(Object.keys(RULE_META).map((rule) => [rule, {}]));
for (const file of [...sourceFiles("."), ...cssFiles()]) {
  const rel = relative(SRC, file);
  for (const { rule } of frontendViolations(rel, readFileSync(file, "utf8"))) {
    const counts = countsByRule.get(rule)!;
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
}

describe("allowlists: platform globals, native elements and stylesheets", () => {
  for (const [rule, meta] of Object.entries(RULE_META)) {
    it(rule, () => {
      const result = checkRule(rule, countsByRule.get(rule)!, meta);
      for (const note of result.notes) console.info(note);
      expect(result.errors.join("\n")).toBe("");
    });
  }
});

describe("colours are read only through --ac-* tokens", () => {
  const files = [...cssFiles(), ...sourceFiles(".").filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))].map((file) => ({ file, rel: relative(SRC, file) }));
  const source = (file: string) => readFileSync(file, "utf8");
  const locals = new Set<string>();
  for (const { file, rel } of files) {
    if (!inOwners(rel, TOKEN_DEFINITION_EXEMPT)) for (const name of definedProperties(source(file))) locals.add(name);
  }
  const prefixes = TOKEN_PREFIX_OWNERS.map((o) => o.pattern);
  const counts: Record<string, number> = {};
  for (const { file, rel } of files) {
    if (inOwners(rel, Object.keys(CSS_EXEMPT)) || rel.startsWith("styles/tokens") || rel === "styles/theme-tokens.css") continue;
    const n = legacyTokenUses(source(file), prefixes, locals).length;
    if (n) counts[rel] = n;
  }
  it("css-legacy-token", () => {
    const result = checkRule("fe-css-legacy-token", counts, { what: "an older colour alias (var(--accent), --muted, --onden-text-muted …)", owner: "the --ac-* token it stands for (styles/tokens.css)" });
    for (const note of result.notes) console.info(note);
    expect(result.errors.join("\n")).toBe("");
  });
});
