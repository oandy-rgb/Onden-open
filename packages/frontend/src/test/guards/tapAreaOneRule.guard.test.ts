// @vitest-environment node
// Guard: an element's invisible touch area (its ::after) is placed by ONE rule. `.tap-target` (styles/global.css)
// centres its ::after with left/top 50%, a width, a height and translate(-50%, -50%). A component rule that gives the
// same element's ::after its own `inset` wins the insets but not the transform: both then apply, and the box stands
// half its height higher and half its width to the left. Measured on the owner's tablet (2026-11-15): the touch areas
// of the words under a note's title lay over the lower half of the title, so selecting text in the title pressed them.
// A rule like that must switch the shared centring off (`transform: none`, and `width: auto; height: auto`).
import { describe, expect, it } from "vitest";
import { readSource, sourceFiles } from "../a11y/sourceFiles";

type Rule = { file: string; selector: string; body: string };

/** The rules of a stylesheet, flat: nested at-rules (@media) contribute their inner rules. */
function rulesOf(file: string): Rule[] {
  const css = readSource(file).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const walk = (text: string) => {
    let depth = 0, start = 0, head = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") { if (depth === 0) { head = text.slice(start, i).trim(); start = i + 1; } depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const body = text.slice(start, i);
          if (head.startsWith("@")) walk(body); else out.push({ file, selector: head, body });
          start = i + 1;
        }
      }
    }
  };
  walk(css);
  return out;
}

const cssFiles = sourceFiles("", [".css"]);
const rules = cssFiles.flatMap(rulesOf);

/** The class names of the element a selector's last compound names (`:is(.a, .b)` lists included). */
function classesOfSubject(selector: string): string[] {
  const last = selector.split(",").flatMap((part) => {
    const subject = part.trim().replace(/::after$/, "");
    // The last compound: after the last combinator that is outside parentheses.
    let depth = 0, cut = 0;
    for (let i = 0; i < subject.length; i++) {
      const ch = subject[i];
      if (ch === "(") depth++; else if (ch === ")") depth--;
      else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) cut = i + 1;
    }
    return [subject.slice(cut)];
  });
  return [...new Set(last.flatMap((compound) => [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)))];
}

/** Class names that some markup gives together with `tap-target` (one className string holding both). */
const withTapTarget = new Set<string>();
for (const file of sourceFiles("", [".tsx"])) {
  for (const m of readSource(file).matchAll(/["'`]([^"'`\n]*\btap-target\b[^"'`\n]*)["'`]/g)) {
    for (const name of m[1]!.split(/[\s${}]+/)) if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && name !== "tap-target") withTapTarget.add(name);
  }
}

describe("an invisible touch area is placed by one rule", () => {
  it("finds the shared rule and markup that uses it (the guard is looking at something)", () => {
    expect(rules.some((r) => r.file === "styles/global.css" && /\.tap-target::after/.test(r.selector) && /translate\(-50%, -50%\)/.test(r.body))).toBe(true);
    expect(withTapTarget.size).toBeGreaterThan(5);
  });

  it("a component rule that insets the ::after of a .tap-target element switches the shared centring off", () => {
    const offenders = rules
      .filter((r) => r.file !== "styles/global.css" && /::after\s*$|::after\s*,/.test(r.selector + ",") && /(^|[;\s])inset\s*:/.test(r.body))
      .filter((r) => classesOfSubject(r.selector).some((name) => withTapTarget.has(name)))
      .filter((r) => {
        // The same selector may reset the centring in another rule of the same file (the base rule, with the
        // touch-size rule only changing the insets).
        const same = rules.filter((o) => o.file === r.file && o.selector === r.selector);
        return !same.some((o) => /transform\s*:\s*none/.test(o.body) && /width\s*:\s*auto/.test(o.body) && /height\s*:\s*auto/.test(o.body));
      })
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it("the words under a note's title keep their touch area off the title", () => {
    const meta = rules.filter((r) => r.file === "components/OverviewEditor.css" && /\.note-meta-line :is\(\.space-chip[^)]*\)::after/.test(r.selector));
    expect(meta.some((r) => /transform\s*:\s*none/.test(r.body) && /width\s*:\s*auto/.test(r.body) && /height\s*:\s*auto/.test(r.body))).toBe(true);
    const move = rules.filter((r) => r.file === "components/NoteBreadcrumb.css" && /\.breadcrumb-move\.tap-target::after/.test(r.selector));
    expect(move.some((r) => /bottom\s*:\s*-6px/.test(r.body) && /top\s*:\s*auto/.test(r.body))).toBe(true);
  });
});
