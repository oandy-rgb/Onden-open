// Every tap in the app was 0.2 s late on the owner's tablet (Samsung Internet, 2026-11-17): the browser held the click
// back for a possible double tap, 205–227 ms after the finger lifted against 4–5 ms with `touch-action: manipulation`
// on the root. The rule is one line in styles/global.css and nothing else would notice if it went away.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const css = readFileSync(join(FRONTEND, "src/styles/global.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("a tap is not held back for a double tap", () => {
  it("the root element has touch-action: manipulation", () => {
    const rootRules = [...css.matchAll(/(?:^|})\s*html\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rootRules.some((body) => /touch-action:\s*manipulation\s*;/.test(body))).toBe(true);
  });
  it("no rule gives the whole page back to the browser's default", () => {
    expect(/(?:^|})\s*(?:html|body|\*|:root)\s*\{[^}]*touch-action:\s*auto/.test(css)).toBe(false);
  });
});
