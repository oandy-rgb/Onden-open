// Guard: History (services/history) says each thing once. The 2026-10-27 deep-modules review
// (docs/archive/research/review-2026-10-27/deep-modules-history.md) found the same rule written several times
// and drifting; these scans fail when a second copy appears. They read source text, so a failure
// names the file and the line. To make an exception, add it to EXCEPTIONS with the reason.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HISTORY_DIR = join(SRC, "services/history");

const historyFiles = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".ts")).map((f) => `services/history/${f}`);
const watched = [...historyFiles, "routes/history.ts"];

/** Source with comment-only lines removed, as [line number, text]. */
function codeLines(file: string): Array<[number, string]> {
  return readFileSync(join(SRC, file), "utf8").split("\n")
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => !/^\s*(\/\/|\/\*|\*)/.test(text));
}

/** Lines of `files` that match `pattern`, minus the `allowed` files. */
function offenders(files: string[], pattern: RegExp, allowed: readonly string[] = []): string[] {
  return files.filter((f) => !allowed.includes(f)).flatMap((file) =>
    codeLines(file).filter(([, text]) => pattern.test(text)).map(([n, text]) => `${file}:${n}: ${text.trim()}`));
}

/** Allowed copies, each with why. Keep this short; every entry is a place that can drift. */
// ratchet:list EXCEPTIONS
const EXCEPTIONS = {
  // 最近刪除 is a list of deleted roots, not a scope over live + trashed notes: it asks readPolicy for
  // the readable deleted ids itself and filters on deleted_at / parent, which readableNotesSql does not model.
  trashedIdsOutsideReadableNotes: ["services/history/activity.ts"],
  // recentlyDeleted / deletedNoteBody filter that same deleted-only list by space on the row itself.
  deletedListSpaceFilter: ["services/history/activity.ts"],
} as const;

describe("History says each thing once (backend)", () => {
  it("the history services are the files this guard scans", () => {
    expect(historyFiles).toEqual(expect.arrayContaining([
      "services/history/activity.ts", "services/history/agentRuns.ts", "services/history/pointInTime.ts",
      "services/history/rewind.ts", "services/history/noteVersions.ts", "services/history/bodyEvents.ts", "services/history/readableNotes.ts",
    ]));
  });

  it("paragraphs: no Markdown block regex (heading, list marker, fence) — cutting, pairing and counting are @onden/markdown's paragraphs.ts", () => {
    expect(offenders(watched, /#\{1,6\}|~~~|\[-\*\+\]|\^\\s\*\(/)).toEqual([]);
    expect(offenders(watched, /function\s+(segmentMarkdown|splitParagraphs|alignParagraphs|touchedSegments)\b/)).toEqual([]);
    // …and the rest of the backend does not grow its own either.
    const rest = ["services/eventLog/bodyMerge.ts"];
    expect(offenders(rest, /function\s+(segmentMarkdown|splitParagraphs|alignParagraphs)\b/)).toEqual([]);
  });

  it("change counts are paragraphs: no line counting in History", () => {
    expect(offenders(watched, /countLineChanges/)).toEqual([]);
  });

  it("which events change a note's text is bodyEvents.ts's alone", () => {
    expect(offenders(watched, /payload\s*\?\s*'body_hash'/, ["services/history/bodyEvents.ts"])).toEqual([]);
    expect(offenders(watched, /'NODE_CREATED'\s*,\s*'NODE_UPDATED'/, ["services/history/bodyEvents.ts"])).toEqual([]);
  });

  it("bodiesByHash is defined once, in bodyEvents.ts", () => {
    expect(offenders(watched, /function\s+bodiesByHash\b/, ["services/history/bodyEvents.ts"])).toEqual([]);
    expect(offenders(watched, /bodiesByHash.*from\s+"\.\/agentRuns\.js"|import\s*\{[^}]*bodiesByHash[^}]*\}\s*from\s*"\.\/agentRuns\.js"/)).toEqual([]);
  });

  it("the two shared files are leaves: they import no sibling History file, so the pages cannot form a cycle through them", () => {
    for (const file of ["services/history/bodyEvents.ts", "services/history/readableNotes.ts"]) {
      expect(offenders([file], /from\s+"\.\/[^"]+"/)).toEqual([]);
    }
  });

  it("pointInTime and rewind do not reach into agentRuns or activity (the old activity → rewind → agentRuns cross-dependency)", () => {
    expect(offenders(["services/history/pointInTime.ts", "services/history/rewind.ts"], /from\s+"\.\/(agentRuns|activity)\.js"/)).toEqual([]);
  });

  it("'readable notes + 最近刪除 + space' is readableNotesSql's alone", () => {
    expect(offenders(watched, /readableScopeSql\(/, ["services/history/readableNotes.ts"])).toEqual([]);
    expect(offenders(watched, /readableTrashedNodeIds\(/, ["services/history/readableNotes.ts", ...EXCEPTIONS.trashedIdsOutsideReadableNotes])).toEqual([]);
    // each page that scopes content_nodes asks for it
    for (const file of ["services/history/activity.ts", "services/history/agentRuns.ts", "services/history/pointInTime.ts", "services/history/rewind.ts"]) {
      expect(offenders([file], /readableNotesSql\(/)).not.toEqual([]);
    }
  });

  it("a space filter is applied by readableNotesSql, not re-spelled per page", () => {
    expect(offenders(watched, /\.space_id\s*=\s*\$\$\{params\.push/, ["services/history/readableNotes.ts", ...EXCEPTIONS.deletedListSpaceFilter])).toEqual([]);
  });
});

describe("the guard scans real code", () => {
  it("finds a planted copy", () => {
    // the scanner itself works: a pattern known to exist elsewhere in the tree is found
    expect(offenders(["services/history/bodyEvents.ts"], /payload\s*\?\s*'body_hash'/)).not.toEqual([]);
    expect(relative(SRC, HISTORY_DIR)).toBe("services/history");
  });
});
