// Guard for dedupe batch 2, cross-package constants (docs/research/dup-patterns-2026-10-30-cross.md
// items 1, 3, 8, 10, 11, 12, 13, 15). Allowlist, deny by default: each rule names the one file that
// may do the thing; any other file fails. An exception says why, and one that no longer matches
// fails too, so the lists only shrink. Each rule proves its pattern on a sample that must match.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FILES, staleAllowances, violations, type OwnerRule } from "./sources";

type Rule = OwnerRule & { sample: string; /** Only files whose path starts with one of these are checked (default: all). */ within?: string[] };

const RULES: Record<string, Rule> = {
  "site languages are one list": {
    what: "a list or union holding both zh-TW and ja, or a test for ja (@onden/markdown SITE_LOCALES / siteLang)",
    pattern: /["']zh-TW["'][^\n]{0,80}["']ja["']|["']ja["'][^\n]{0,80}["']zh-TW["']|===\s*["']ja["']|value:\s*["']ja["']/,
    owners: ["markdown/src/siteHead.ts"],
    sample: 'const LANGS = ["zh-TW", "en", "ja"];',
  },
  "published titles and sibling order sort through compareTitles / compareIso": {
    what: "localeCompare in the site, the website module or the studio (@onden/markdown childOrder.ts compareTitles / compareText)",
    pattern: /\.localeCompare\(/,
    owners: [],
    within: ["site/src/", "backend/src/modules/website/", "frontend/src/components/siteFrame/", "frontend/src/modules/website/"],
    sample: "rows.sort((a, b) => a.title.localeCompare(b.title));",
  },
  "a system attribute key is told by isSystemAttr": {
    what: 'startsWith("_") on an attribute key (@onden/markdown sharedContract.ts isSystemAttr)',
    pattern: /\.startsWith\(\s*["']_["']\s*\)/,
    owners: ["markdown/src/sharedContract.ts"],
    exceptions: {
      "backend/src/spine/noteSlugs.ts": "a note's slug that starts with `_` is reserved (a slug, not an attribute key; slugFor moved from services/nodes.ts in batch 4a)",
      "frontend/src/components/NodeAttributesPanel.tsx": "file is being edited in an open PR; move it to isShownPropertyKey (lib/childFields.ts) and delete INTERNAL_ATTRIBUTE_KEYS (components/attributes/utils.ts)",
    },
    sample: 'return !key.startsWith("_");',
  },
  "the editors' own storage attributes are one list": {
    what: "a retyped list of ink_data / page_text / pdf_* keys (@onden/markdown EDITOR_STORAGE_ATTR_KEYS)",
    pattern: /["']ink_data["'],\s*["']page_text["']/,
    owners: ["markdown/src/sharedContract.ts"],
    exceptions: {
      "frontend/src/components/OverviewEditor.tsx": "the keys to load for a drawing or PDF note (a fetch list, not the hidden-property list)",
    },
    sample: 'new Set(["ink_data", "page_text"])',
  },
  "the custom-domain host rule is written once": {
    what: "the host-name pattern of a custom domain (@onden/markdown sharedContract.ts isCustomDomainHost)",
    pattern: /\(\?=\.\{1,253\}\$\)/,
    owners: ["markdown/src/sharedContract.ts"],
    sample: "/^(?=.{1,253}$)([a-z0-9])$/i",
  },
  "which extensions and MIME types are images is mediaTypes.ts's table": {
    what: "png|jpe?g or an image/png literal (@onden/markdown mediaTypes.ts)",
    pattern: /png\|jpe\?g|["']image\/png["']/,
    owners: ["markdown/src/mediaTypes.ts"],
    sample: "const IMAGE = /\\.(png|jpe?g)$/;",
  },
  "an id is checked as a UUID by isUuid / UUID_SOURCE, not by a loose class": {
    what: "[0-9a-f-]{36} (accepts 36 hyphens; the database cast fails later)",
    pattern: /\[0-9a-fA?-?F?-\]\{36\}|\[0-9a-f\]\{8\}-\[0-9a-f-\]\{27\}/i,
    owners: [],
    sample: "/^[0-9a-f-]{36}$/i.test(id)",
  },
  "task statuses are one list": {
    what: "a retyped list of task statuses (@onden/markdown TASK_STATUSES)",
    pattern: /\[[^\]\n]*["']waiting["'][^\]\n]*["']cancelled["']/,
    owners: ["markdown/src/sharedContract.ts"],
    sample: '["todo", "doing", "waiting", "done", "cancelled"]',
  },
  "the reserved tag keys are one table": {
    what: 'the "workspace-config" reserved key (@onden/markdown RESERVED_TAGS)',
    pattern: /["']workspace-config["']/,
    owners: ["markdown/src/sharedContract.ts"],
    sample: 'const KEY = "workspace-config";',
  },
  "a new block id is made by newBlockId": {
    what: "random bytes turned into a block id (@onden/markdown blockId.ts newBlockId)",
    pattern: /getRandomValues\(new Uint8Array\(\d\)\)|randomBytes\(\d\)\.toString\("hex"\)\.slice/,
    owners: ["markdown/src/blockId.ts"],
    sample: "const id = randomBytes(4).toString(\"hex\").slice(0, 6);",
  },
};

describe.each(Object.entries(RULES))("%s", (_name, rule) => {
  const files = rule.within ? FILES.filter((f) => rule.within!.some((prefix) => f.path.startsWith(prefix))) : FILES;
  it("only the owner does it", () => {
    expect(violations(files, rule), rule.what).toEqual([]);
  });

  it("every owner and exception still matches (delete the ones that no longer do)", () => {
    expect(staleAllowances(files, rule)).toEqual([]);
  });

  it("the pattern catches a sample (a regex that matched nothing would pass for nothing)", () => {
    expect(rule.pattern.test(rule.sample)).toBe(true);
  });
});

describe("the long-form checks", () => {
  it("the 36-character UUID pattern also catches the quantified forms exportZip used", () => {
    expect(RULES["an id is checked as a UUID by isUuid / UUID_SOURCE, not by a loose class"].pattern.test("onden://node/([0-9a-fA-F-]{36})")).toBe(true);
  });
});

// ── comments that name a file ──────────────────────────────────────────────────────────────────
// A comment that says "same as lib/foo.ts" keeps two copies in step only while that file exists
// (cross item 15: three of them pointed at files that were renamed or removed). Every `lib/`,
// `services/`, `modules/`, `components/`, `spine/`, `routes/` or `hooks/` path named in a comment
// of production code must end a real source path in one of the four packages.
const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist"].includes(entry.name) ? [] : allFiles(path);
    return /\.(ts|tsx|css|mjs|json|sql)$/.test(entry.name) ? [path] : [];
  });
}

const COMMENTED_PATH = /\b((?:lib|services|modules|components|spine|routes|hooks)\/[A-Za-z0-9_/.-]+\.(?:ts|tsx))\b/g;

/** `file:line  path` of every named path in a comment that matches no real file. */
export function danglingCommentPaths(files: Array<{ path: string; text: string }>, real: string[]): string[] {
  const exists = (path: string) => real.some((r) => r === path || r.endsWith(`/${path}`));
  return files.flatMap((file) => file.text.split("\n").flatMap((line, i) => {
    const comment = /^\s*(?:\/\/|\*|\/\*)(.*)$/.exec(line)?.[1] ?? /\s\/\/(.*)$/.exec(line)?.[1] ?? /\/\*(.*)$/.exec(line)?.[1];
    if (comment === undefined) return [];
    return [...comment.matchAll(COMMENTED_PATH)].filter((hit) => !exists(hit[1]!)).map((hit) => `${file.path}:${i + 1}  ${hit[1]}`);
  }));
}

describe("a comment names a file that exists", () => {
  const real = ["markdown", "site", "backend", "frontend"].flatMap((pkg) => allFiles(join(PACKAGES, pkg, "src"))).map((file) => relative(PACKAGES, file).split(sep).join("/"));
  const production = ["markdown", "site", "backend", "frontend"].flatMap((pkg) => allFiles(join(PACKAGES, pkg, "src")))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.(test|spec|testing)\./.test(file) && !/\/(test|fixtures|__snapshots__)\//.test(file))
    .map((file) => ({ path: relative(PACKAGES, file).split(sep).join("/"), text: readFileSync(file, "utf8") }));

  /** `path` → why it names a path outside these four packages' src (another project, or a file in an open PR). */
  // ratchet:list EXCEPTIONS
  const EXCEPTIONS: Record<string, string> = {
    "backend/src/services/eventRestore/restore.ts": "names Trilium's services/notes.ts, the project this was modelled on",
    "backend/src/utils.ts": "names Trilium's and Joplin's parsers it was modelled on",
    "frontend/src/lib/settingsTypes.ts": "names Joplin's settings table it was modelled on",
    "backend/src/modules/website/publishing/snapshot.ts": "comment about the former routes/publish.ts; the file is being edited in an open PR",
  };

  const dangling = danglingCommentPaths(production, real);
  const outsideExceptions = dangling.filter((hit) => !Object.keys(EXCEPTIONS).some((path) => hit.startsWith(`${path}:`)));

  it("every named path exists", () => {
    expect(outsideExceptions, "fix the comment: name the file that is there now").toEqual([]);
  });

  it("every exception still names a missing path (delete the ones that were fixed)", () => {
    const stale = Object.keys(EXCEPTIONS).filter((path) => !dangling.some((hit) => hit.startsWith(`${path}:`)));
    expect(stale).toEqual([]);
  });

  it("the check catches a path that is not there and accepts one that is", () => {
    const sample = [{ path: "x.ts", text: "// same as lib/noSuchFile.ts\n// see lib/childOrder.ts\nconst a = 1; // services/gone.ts" }];
    const found = danglingCommentPaths(sample, ["frontend/src/lib/childOrder.ts"]);
    expect(found).toEqual(["x.ts:1  lib/noSuchFile.ts", "x.ts:3  services/gone.ts"]);
  });
});
