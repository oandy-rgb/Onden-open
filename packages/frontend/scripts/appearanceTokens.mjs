// The SET of design tokens per kind, frozen. The css-* guards stop a raw value where a token belongs; they do not stop the
// token list itself from growing (13 font sizes, 6 radii, 22 layers were all "legal"). This is the other half: a token defined in
// the token files that is not in scripts/appearance-token-baseline.json fails the guard (src/test/guards/appearanceTokens.guard.test.ts).
// ONE source of truth: that JSON file. The list in docs/agents/appearance-rules.md §七 is generated from it (this file, `npm run appearance:tokens`)
// and the guard checks the two are identical; the JSON is a ratchet file (scripts/*baseline*.json), so adding a name needs the owner's override.
//   node packages/frontend/scripts/appearanceTokens.mjs            print today's sets
//   node packages/frontend/scripts/appearanceTokens.mjs --doc      rewrite the generated list in the rules document from the JSON
//   node packages/frontend/scripts/appearanceTokens.mjs --init     write the JSON from the token files (first time only; refuses to add names later)
import postcss from "postcss";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
export const TOKEN_FILES = ["packages/frontend/src/styles/tokens.css", "packages/frontend/src/styles/theme-tokens.css"];
export const TOKEN_BASELINE_FILE = join(REPO, "scripts/appearance-token-baseline.json");
export const RULES_DOC_FILE = join(REPO, "docs/agents/appearance-rules.md");
export const DOC_BEGIN = "<!-- appearance-tokens:begin（由 npm run appearance:tokens 從 scripts/appearance-token-baseline.json 產生，不要手改） -->";
export const DOC_END = "<!-- appearance-tokens:end -->";

/** name pattern → kind, first match wins. What is not matched is a colour when its value is one, else "other" (layout sizes, widths…). */
const BY_NAME = [
  [/^--z-/, "z-index"],
  [/^--(ac-fs-|onden-text-(xs|sm|sm2|base|md|lg|xl|2xl|3xl)$)/, "font-size"],
  [/^--(ac-radius-|onden-radius-)/, "radius"],
  [/^--ac-space-/, "spacing"],
  [/^--(ac-fw-|onden-weight-)/, "font-weight"],
  [/^--(ac-lh-|onden-leading-)/, "line-height"],
  [/^--onden-tracking-/, "letter-spacing"],
  [/^--(ac-font-|onden-font-|font-|onden-ui-font)/, "font-family"],
  [/^--(ac-row|ac-control-|ac-tap$|onden-control-|onden-tap$)/, "control-height"],
  [/^--(ac-prose-max|ac-page-column|ac-list-max|ac-width-)/, "max-width"],
  [/^--ac-border-/, "border-width"],
  [/^--ac-opacity-/, "opacity"],
  [/^--(onden-ease-|onden-motion-ease)/, "easing"],
  [/^--(onden-motion-|ac-duration-)/, "transition-ms"],
  [/^--ac-focus-(outline|offset|inset)$/, "focus-ring"],
  [/^--ac-icon-/, "icon"],
  [/^--(ac-shadow-|ac-ring|ac-inset-ring|ac-bar-|ac-edge-|ac-focus-ring$|onden-shadow|shadow$|onden-focus-ring$)/, "shadow"],
];
const COLOUR_VALUE = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(|\b(transparent|currentcolor)\b/i;

/** Every custom property the token files define: `{ name: [values…] }` (a name may be defined for light, dark, density…). */
export function definedTokens(sources) {
  const out = {};
  for (const { file, text } of sources) {
    postcss.parse(text, { from: file }).walkDecls(/^--/, (decl) => (out[decl.prop] ||= []).push(decl.value));
  }
  return out;
}

/** `{ kind: [names sorted] }`. A name with no kind by name is a colour when any of its values is one (or points at a colour name). */
export function tokenSets(defined) {
  const kindOf = {};
  for (const name of Object.keys(defined)) {
    const hit = BY_NAME.find(([re]) => re.test(name));
    if (hit) kindOf[name] = hit[1];
  }
  const isColourValue = (value) => COLOUR_VALUE.test(value) || [...value.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => kindOf[m[1]] === "colour");
  // a value that points at another colour name makes this one a colour: repeat until nothing changes
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, values] of Object.entries(defined)) {
      if (kindOf[name]) continue;
      if (values.some(isColourValue)) { kindOf[name] = "colour"; changed = true; }
    }
  }
  const sets = {};
  for (const name of Object.keys(defined)) (sets[kindOf[name] ?? "other"] ||= []).push(name);
  return Object.fromEntries(Object.entries(sets).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, names]) => [k, names.sort()]));
}

/** Names defined today that the frozen file does not list: `[{ name, kind }]`. A name listed under another kind is also reported (a rename of kind is a change). */
export function unlistedTokens(sets, frozen) {
  const listed = new Map(Object.entries(frozen).flatMap(([kind, names]) => names.map((n) => [n, kind])));
  return Object.entries(sets).flatMap(([kind, names]) => names.filter((n) => listed.get(n) !== kind).map((name) => ({ name, kind })));
}

export const readTokenSources = (repo = REPO) => TOKEN_FILES.map((file) => ({ file, text: readFileSync(join(repo, file), "utf8") }));
export const readFrozenTokens = (file = TOKEN_BASELINE_FILE) => JSON.parse(readFileSync(file, "utf8"));

/** The generated list for the rules document (between DOC_BEGIN and DOC_END). */
export function renderTokenList(frozen) {
  const lines = [DOC_BEGIN, ""];
  for (const [kind, names] of Object.entries(frozen)) lines.push(`- \`${kind}\`（${names.length}）：${names.map((n) => `\`${n}\``).join("、")}`);
  lines.push("", DOC_END);
  return lines.join("\n");
}

/** The document with its generated list replaced (or the whole section checked, when `doc` has no markers yet it throws). */
export function withTokenList(doc, frozen) {
  const a = doc.indexOf(DOC_BEGIN), b = doc.indexOf(DOC_END);
  if (a < 0 || b < 0) throw new Error("rules document has no appearance-tokens markers");
  return doc.slice(0, a) + renderTokenList(frozen) + doc.slice(b + DOC_END.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sets = tokenSets(definedTokens(readTokenSources()));
  if (process.argv.includes("--init")) {
    if (existsSync(TOKEN_BASELINE_FILE)) { console.error("scripts/appearance-token-baseline.json already exists: a new token is added by hand with the owner's ratchet-override, not regenerated"); process.exit(1); }
    writeFileSync(TOKEN_BASELINE_FILE, `${JSON.stringify(sets, null, 2)}\n`);
  } else if (process.argv.includes("--doc")) {
    writeFileSync(RULES_DOC_FILE, withTokenList(readFileSync(RULES_DOC_FILE, "utf8"), readFrozenTokens()));
    console.log("已更新規則文件裡的 token 名單");
  } else for (const [k, n] of Object.entries(sets)) console.log(`${k}\t${n.length}`);
}
