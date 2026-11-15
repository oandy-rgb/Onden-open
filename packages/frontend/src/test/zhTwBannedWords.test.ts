import { describe, expect, it } from "vitest";
import { ZH_TW } from "../lib/i18n.zh-TW";

// Owner rule: user-facing text has no engineering words, and one idea has one
// word (「功能」 for modules, 「金鑰」 for tokens). Code identifiers keep their
// names; only the dictionary values reach the screen.
const BANNED = /模組|LWW|frontmatter|token|schema|JSON/i;

// Keys whose value may still contain a banned word, and why. Add to this list
// only for a name the person has to recognise on disk.
const ALLOWED: Record<string, string> = {
};

describe("zh-TW dictionary", () => {
  it("has none of the banned user-facing words outside the allowlist", () => {
    const hits = Object.entries(ZH_TW)
      .filter(([key, value]) => BANNED.test(value) && !(key in ALLOWED))
      .map(([key, value]) => `${key} => ${value}`);
    expect(hits).toEqual([]);
  });

  it("keeps the allowlist honest: every entry still exists and still needs it", () => {
    for (const key of Object.keys(ALLOWED)) {
      expect(ZH_TW[key], key).toBeDefined();
      expect(BANNED.test(ZH_TW[key]), key).toBe(true);
    }
  });
});
