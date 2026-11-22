// @vitest-environment node
// Guard: the SET of design tokens per kind does not grow. The css-* guards stop raw values; this stops "one more token"
// (13 font sizes, 6 radii, 22 layers, 33 shadows and 97 colours each got there one reasonable token at a time).
// Source of truth: scripts/appearance-token-baseline.json (a ratchet file: a new name needs the owner's ratchet-override).
// The list in docs/agents/appearance-rules.md §七 is generated from it and must be identical (npm run appearance:tokens).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  definedTokens, DOC_BEGIN, DOC_END, readFrozenTokens, readTokenSources, RULES_DOC_FILE, tokenSets, unlistedTokens, withTokenList,
} from "../../../scripts/appearanceTokens.mjs";

const frozen = readFrozenTokens();
const today = tokenSets(definedTokens(readTokenSources()));

describe("the token sets are frozen", () => {
  it("every token the token files define is listed in scripts/appearance-token-baseline.json under its kind", () => {
    const added = unlistedTokens(today, frozen);
    expect(
      added.map(({ name, kind }) => `${name}（${kind}）`).join("、"),
      "這些 token 不在凍結名單：不要新增 token，改用名單裡既有的；真的需要新的層級，由擁有者先在 docs/agents/appearance-rules.md 決定，再把名字加進 scripts/appearance-token-baseline.json（棘輪會要求 ratchet-override），並跑 npm run appearance:tokens 更新文件",
    ).toBe("");
  });
  it("the list in the rules document is the one generated from the JSON", () => {
    const doc = readFileSync(RULES_DOC_FILE, "utf8");
    expect(doc.includes(DOC_BEGIN) && doc.includes(DOC_END), "appearance-rules.md §七 lost its generated markers").toBe(true);
    expect(doc === withTokenList(doc, frozen), "appearance-rules.md §七 的名單和 scripts/appearance-token-baseline.json 不同：跑 npm run appearance:tokens").toBe(true);
  });
  it("a name that is gone from the token files is not an error (the list may shrink)", () => {
    expect(unlistedTokens({ colour: ["--a"] }, { colour: ["--a", "--gone"] })).toEqual([]);
  });
});

describe("the check itself", () => {
  const sources = (css: string) => [{ file: "t.css", text: css }];
  const sets = (css: string) => tokenSets(definedTokens(sources(css)));
  it("refuses a new token that is not in the list, whatever its kind", () => {
    const next = sets(`:root { --ac-fs-ui: 14px; --ac-fs-huge: 40px; --ac-radius-pill: 99px; --z-new: 5; --ac-shadow-glow: 0 0 4px red; --ac-brand: #123456; }`);
    const old = { "font-size": ["--ac-fs-ui"] };
    expect(unlistedTokens(next, old).map((t) => `${t.name}:${t.kind}`)).toEqual(["--ac-brand:colour", "--ac-fs-huge:font-size", "--ac-radius-pill:radius", "--ac-shadow-glow:shadow", "--z-new:z-index"]);
  });
  it("refuses a listed name that moved to another kind", () => {
    expect(unlistedTokens({ colour: ["--ac-x"] }, { other: ["--ac-x"] })).toEqual([{ name: "--ac-x", kind: "colour" }]);
  });
  it("sorts a name by its prefix, then by its value (a colour, or a name that points at a colour)", () => {
    const s = sets(`:root { --ac-bg: #fff; --ac-bg-2: var(--ac-bg); --ac-gap: 4px; --ac-space-9: 32px; --onden-text-md: 15px; --onden-text-muted: #666; }`);
    expect(s).toEqual({ colour: ["--ac-bg", "--ac-bg-2", "--onden-text-muted"], "font-size": ["--onden-text-md"], other: ["--ac-gap"], spacing: ["--ac-space-9"] });
  });
  it("a name defined for light and for dark counts once", () => {
    expect(sets(`:root { --ac-bg: #fff; } html[data-theme=dark] { --ac-bg: #000; }`)).toEqual({ colour: ["--ac-bg"] });
  });
});
