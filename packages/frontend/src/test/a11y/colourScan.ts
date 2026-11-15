// Finds colour literals in text/background declarations of the component CSS.
import { readSource, sourceFiles } from "./sourceFiles";

// Not the app palette: tokens.css / theme-tokens.css define it; the published
// site keeps its own frozen set (tokens.css header).
const OWN_PALETTE = new Set([
  "styles/tokens.css", "styles/theme-tokens.css", "styles/site-tokens.css",
  "styles/published-site.css",
]);

const PROPERTY = /^(color|background|background-color)$/;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(|\b(?:white|black)\b/;

export interface ColourLiteral { file: string; selector: string; property: string; value: string }

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** var(--x, #fff) is a token with a fallback, not a hard-coded colour: drop the fallback arguments. */
function withoutVarFallbacks(value: string): string {
  let out = value;
  for (;;) {
    const next = out.replace(/var\(\s*--[\w-]+\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g, "var()");
    if (next === out) return out;
    out = next;
  }
}

export function colourLiterals(file: string, css: string): ColourLiteral[] {
  const found: ColourLiteral[] = [];
  const text = stripComments(css);
  // Innermost { … } blocks: a rule's selector is the text since the previous brace.
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, " ");
    if (selector.startsWith("@")) continue;
    for (const declaration of rule[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = withoutVarFallbacks(declaration.slice(colon + 1)).replace(/\s+/g, " ").trim();
      if (PROPERTY.test(property) && LITERAL.test(value)) found.push({ file, selector, property, value });
    }
  }
  return found;
}

export function allColourLiterals(): ColourLiteral[] {
  return sourceFiles("", [".css"]).filter((f) => !OWN_PALETTE.has(f)).flatMap((f) => colourLiterals(f, readSource(f)));
}
