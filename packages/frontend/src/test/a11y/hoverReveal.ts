// A control hidden with `opacity: 0` and shown only by :hover cannot be seen
// when the keyboard focuses it. It needs a rule that shows it on focus too.
import { readSource, sourceFiles } from "./sourceFiles";

interface Rule { selector: string; declarations: string }

function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), declarations: m[2] }));
}

const sets = (declarations: string, value: string) => new RegExp(`(^|;|\\s)opacity\\s*:\\s*${value}\\s*(;|$|!)`).test(declarations);
const shows = (declarations: string) => /(^|;|\s)opacity\s*:\s*(1|0?\.\d+)\s*(;|$|!)/.test(declarations);

/** `file .class` for each class that is opacity: 0, revealed on :hover, and not on focus. */
export function hoverOnlyReveals(file: string, css: string): string[] {
  const rules = rulesOf(css).flatMap((r) => r.selector.split(",").map((selector) => ({ selector: selector.trim(), declarations: r.declarations })));
  const hidden = new Set(rules.filter((r) => /^\.[\w-]+$/.test(r.selector) && sets(r.declarations, "0")).map((r) => r.selector));
  const found: string[] = [];
  for (const cls of hidden) {
    const mentions = rules.filter((r) => r.selector.split(/[\s>+~]+/).some((part) => part === cls || part.startsWith(`${cls}:`)));
    const byHover = mentions.some((r) => r.selector.includes(":hover") && shows(r.declarations));
    const byFocus = mentions.some((r) => /:focus(-visible|-within)?/.test(r.selector) && shows(r.declarations));
    if (byHover && !byFocus) found.push(`${file} ${cls}`);
  }
  return found;
}

// Not a tab stop, so there is no keyboard focus to show it for.
const NOT_FOCUSABLE: Record<string, string> = {
  "components/CardNode.css .card-handle": "a graph connection handle: pointer-only, and shown for the selected card too",
};

export function allHoverOnlyReveals(): string[] {
  return sourceFiles("", [".css"]).flatMap((f) => hoverOnlyReveals(f, readSource(f))).filter((id) => !(id in NOT_FOCUSABLE));
}
