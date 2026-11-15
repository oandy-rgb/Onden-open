// Guard for the 2026-10-30 duplicate-pattern batch 1 (docs/research/dup-patterns-2026-10-30-{render,cross}.md).
// Allowlist, deny by default: for each thing below only the named owner file may do it; any other file
// that does fails, and an exception must say why it is not "doing it again". An exception that stops
// matching fails too, so these lists only get shorter.
import { describe, expect, it } from "vitest";
import { buildsHexColourRegExp, declaresName, FILES, nameLengthLimitSites, staleAllowances, violations, type OwnerRule } from "./sources";

/** The text pattern this rule used before it read the syntax tree: kept, so a pattern in a string or comment-free text still counts. */
const HEX_TEXT = /#\[0-9a-f(?:A-F)?\]\{/i;
export const hexColourCheck = ({ path, text }: { path: string; text: string }) => HEX_TEXT.test(text) || buildsHexColourRegExp(path, text);

const RULES: Record<string, OwnerRule> = {
  "callout markers": {
    what: "parse a `[!type]` callout marker (parseCalloutMarker / stripCalloutMarker)",
    pattern: /\\{1,2}\[!|startsWith\(["']\[!/,
    owners: ["markdown/src/callouts.ts"],
  },
  "custom CSS sanitiser": {
    what: "escape `<` for a <style> or define a CSS sanitiser (sanitizeSiteCss)",
    pattern: /\\\\3c |function\s+sanitize\w*Css\b/,
    owners: ["site/src/css.ts"],
  },
  "hex colour check": {
    what: "validate `#rrggbb` with a regexp of your own (isHexColor)",
    pattern: /#/,
    detect: hexColourCheck,
    owners: ["markdown/src/color.ts"],
    exceptions: {
      "markdown/src/pageText.ts": "page text colours accept #rgb and #rrggbbaa on purpose (a wider list than a stored colour)",
      "markdown/src/inkSvg.ts": "ink stroke colours also accept rgb()/hsl()/names on purpose",
    },
  },
  "URL scheme allowlist (anchored http(s) test)": {
    what: "test a URL's scheme with a regexp of your own (isHttpUrl, isSafeLinkHref, isSafeImageSrc)",
    pattern: /\^\(?(?:\?:)?https\?/,
    owners: ["markdown/src/urlSchemes.ts"],
    exceptions: {
      "frontend/src/lib/api.ts": "the API base setting, not a note's link; api.ts is imported by the local-DB worker, which must not load the markdown pipeline",
      "frontend/src/lib/invite.ts": "the API base setting (see api.ts)",
      "frontend/src/lib/auth-client.ts": "the API base setting (see api.ts)",
      "markdown/src/sharedContract.ts": "cleanCustomDomain strips a typed `https://` before the hostname check (the one place, for Settings and the CNAME file); not a link test",
      "backend/src/modules/website/publishing/siteRows.ts": "TEMPORARY: safeImageUrl should be isSafeImageSrc; the file is in refactor/dates-unify's change list, so it moves after that merges",
    },
  },
  "URL scheme allowlist (named schemes)": {
    what: "name `javascript:`, `mailto:` or `tel:` (LINK_SCHEMES)",
    pattern: /["'`](?:javascript|mailto|tel):/i,
    owners: [],
  },
  "inline data: media test": {
    what: "test for `data:image|audio|video` (SAFE_DATA_MEDIA_SRC, SAFE_DATA_IMAGE_SRC)",
    pattern: /\^data:/,
    owners: ["markdown/src/urlSchemes.ts"],
  },
  "word count": {
    what: "count words or CJK characters (countWords, readingMinutes)",
    pattern: /\\p\{Script=Han\}|\\u4e00|一-鿿/,
    owners: ["markdown/src/readingTime.ts"],
    exceptions: {
      "markdown/src/snippet.ts": "a character class for case folding, not a count",
      "backend/src/services/harness/scope.ts": "finds runs of CJK text to search for, not a word count",
    },
  },
  "countWords definition": {
    what: "define a word counter (countWords)",
    pattern: /countWords/,
    detect: (file) => declaresName(file.path, file.text, "countWords"),
    owners: ["markdown/src/readingTime.ts"],
  },
  "name length limits": {
    what: "type a length limit on a name or title (TAG_NAME_MAX, VIEW_NAME_MAX, SPACE_NAME_MAX, TASK_TITLE_MAX, NODE_TITLE_MAX, AI_NAME_MAX)",
    pattern: /\.max\(|maxLength=/,
    detect: (file) => nameLengthLimitSites(file.path, file.text).length > 0,
    owners: [],
    exceptions: {
      "backend/src/modules/importers/obsidian/import.ts": "the name of an import source, not a tag, view, space or task",
      "backend/src/services/agentTools/proposeTagPack.ts": "an attribute field's name inside a proposed pack",
      "backend/src/services/actorPrefs.ts": "a stored preset's label, bounded in units",
      "backend/src/routes/workspace.ts": "a tag name typed to confirm an action, and a person's name to confirm a transfer; they only match, never create",
      "backend/src/routes/nodes.ts": "a fallback title for a link target",
      "frontend/src/modules/skills/NewSkillDialog.tsx": "a skill's title",
      "frontend/src/modules/importers/FolderImportSetting.tsx": "the name of an import source",
      "frontend/src/settings/spacesAndMembers/AddMemberForm.tsx": "a person's name",
      "frontend/src/settings/spacesAndMembers/AddAiRoleWizard.tsx": "an AI role's name and its key's name",
      "frontend/src/settings/ai/HelperMention.tsx": "an @-mention handle",
      "frontend/src/settings/spacesAndMembers/HelperKeys.tsx": "a key's name",
    },
  },
};

describe.each(Object.entries(RULES))("only the owner may %s", (_id, rule) => {
  it("no other file does", () => {
    expect(violations(FILES, rule), rule.what).toEqual([]);
  });

  it("every owner and exception still matches (delete the ones that do not)", () => {
    expect(staleAllowances(FILES, rule)).toEqual([]);
  });

  it("the rule fires on a file that breaks it, and not on its owner", () => {
    const probe = { path: "frontend/src/probe.ts", text: PROBES[_id] ?? "" };
    expect(PROBES[_id], "add a probe for this rule").toBeDefined();
    expect(violations([probe], rule)).toEqual([probe.path]);
    const allowed = rule.owners[0] ?? Object.keys(rule.exceptions ?? {})[0];
    if (allowed) expect(violations([{ ...probe, path: allowed }], rule)).toEqual([]);
  });
});

/** One line of code that each rule must reject (the guard checks itself). */
const PROBES: Record<string, string> = {
  "callout markers": 'const m = /^\\[!(\\w+)\\]/.exec(text);',
  "custom CSS sanitiser": 'return css.replace(/</g, "\\\\3c ");',
  "hex colour check": "const HEX = /^#[0-9a-f]{6}$/i;",
  "URL scheme allowlist (anchored http(s) test)": "if (/^https?:\\/\\//i.test(url)) return url;",
  "URL scheme allowlist (named schemes)": 'const ok = url.startsWith("mailto:");',
  "inline data: media test": "const DATA = /^data:image\\//i;",
  "word count": "const CJK = /[\\p{Script=Han}]/gu;",
  "countWords definition": "export function countWords(text: string) { return 0; }",
  "name length limits": "const Body = z.object({ name: z.string().min(1).max(200) });",
};

describe("the hex colour and countWords guards read the syntax tree", () => {
  it("catches a #rrggbb regexp however it is spelled, and everything the old text pattern caught", () => {
    for (const text of [
      "const A = /^#[0-9a-f]{6}$/i;",
      "const A = /^#[\\da-fA-F]{6}$/;",
      "const A = /^#[A-Fa-f0-9]{6}$/;",
      "const A = /^#[0-9A-F]{6}$/;", // upper case only, no `i` flag
      "const A = /^#[0-9a-f]{8}$/i;", // with alpha
      "const A = /#[0-9a-f]{3,8}/i;", // no anchors
      "const A = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;",
      'const A = new RegExp("^#" + "[0-9a-f]{6}$", "i");',
      'const A = RegExp("^#[a-f0-9]{6}$", "i");',
      'const A = new RegExp("^#[0-9a-f]{6}$");', // a pattern held in a string: the old text pattern still sees it
      'const A = "#[0-9a-f]{6}";',
    ]) expect(hexColourCheck({ path: "frontend/src/probe.ts", text }), text).toBe(true);
  });
  it("leaves other regexps alone", () => {
    for (const text of ["const A = /^#\\d+$/;", "const A = /^[0-9a-f]{6}$/;", "const A = /[\\p{Script=Han}]/u;", "const A = /^#/;"]) {
      expect(hexColourCheck({ path: "frontend/src/probe.ts", text }), text).toBe(false);
    }
  });
  it("catches countWords declared as a function, const, let, method or property, and not a call or an import", () => {
    for (const text of ["export function countWords(t: string) { return 0; }", "export const countWords = (t: string) => 0;", "let countWords = f;", "const o = { countWords(t: string) { return 0; } };", "class A { countWords = 1 }"]) {
      expect(declaresName("frontend/src/probe.ts", text, "countWords"), text).toBe(true);
    }
    for (const text of ['import { countWords } from "@onden/markdown";\nconst n = countWords(body);', "// function countWords() {}", "const countWordsLabel = 1;", "const o = { countWords };", 'const { countWords } = await import("@onden/markdown");', "const { countWords } = counters;"]) {
      expect(declaresName("frontend/src/probe.ts", text, "countWords"), text).toBe(false);
    }
  });
});

/** Name-length guard, by syntax: what it must catch (even when the code is reformatted) and what it must leave alone. */
describe("name length limits read the syntax tree", () => {
  const sites = (text: string, path = "frontend/src/probe.ts") => nameLengthLimitSites(path, text).length;

  it("catches a number literal on a name or title, however the code is laid out", () => {
    expect(sites("const B = z.object({\n  title: z.string()\n    .trim()\n    .max(120),\n});")).toBe(1);
    expect(sites('const B = z.object({ "tag_name": z.string().max(80) });')).toBe(1);
    expect(sites("const B = z.object({ name: z.preprocess(trim, z.string().max(80)) });")).toBe(1);
    expect(sites("const nameSchema = z.string().max(200);")).toBe(1);
    expect(sites("const el = <input value={filename} maxLength={80} />;", "frontend/src/probe.tsx")).toBe(1);
    expect(sites("const el = <input value={tagName} maxLength={80} />;", "frontend/src/probe.tsx")).toBe(1);
    expect(sites("const el = <input\n  maxLength={80}\n  aria-label=\"Title\"\n/>;", "frontend/src/probe.tsx")).toBe(1);
  });

  it("leaves alone a limit from a constant, and a number that belongs to another field (the 2026-11 false alarms)", () => {
    expect(sites("const B = z.object({ name: z.string().max(AI_NAME_MAX), note: z.string().max(500) });")).toBe(0);
    expect(sites("const B = z.object({ name: z.string().max(AI_NAME_MAX) });\nconst C = z.object({ body: z.string().max(500) });")).toBe(0);
    expect(sites("const B = z.object({ meta: z.object({ name: z.string().max(NAME_MAX), size: z.number().max(10) }) });")).toBe(0);
    expect(sites("const el = <input aria-label={nameLabel} maxLength={NAME_MAX} />;", "frontend/src/probe.tsx")).toBe(0);
    expect(sites("const el = <textarea value={body} maxLength={500} />;", "frontend/src/probe.tsx")).toBe(0);
    expect(sites("const el = <TextField className={classNames(\"code\")} maxLength={7} onKeyDown={() => pick.name} />;", "frontend/src/probe.tsx")).toBe(0);
    expect(sites("const titleWidth = Math.max(120, w);")).toBe(0);
    expect(sites("const o = { nameCol: Math.max(80, x) };")).toBe(0);
    expect(sites("const o = { title: clamp.max(1, 2) };")).toBe(0);
    expect(sites("// name: z.string().max(200)\nconst x = 1;")).toBe(0);
  });
});
