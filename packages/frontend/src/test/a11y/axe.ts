// axe-core configured for what jsdom can judge: WCAG 2.0/2.1 A and AA rules,
// without color-contrast (jsdom has no layout or computed colour; contrast.test.ts
// covers the colour tokens instead).
import { configureAxe, type AxeCore } from "vitest-axe";

const run = configureAxe({
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  rules: { "color-contrast": { enabled: false } },
});

/** One id per broken rule and the surface it broke on: `settings (phone): button-name`. */
export async function axeViolationIds(surface: string, root: Element): Promise<string[]> {
  const results: AxeCore.AxeResults = await run(root);
  return results.violations.map((v) => `${surface}: ${v.id}`);
}
