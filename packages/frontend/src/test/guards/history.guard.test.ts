// @vitest-environment node
// Guard: History (lib/history, components/history) says each thing once. The 2026-10-27 deep-modules
// review (docs/archive/research/review-2026-10-27/deep-modules-history.md) found paragraph cutting written
// three times, two copies of the undo card, writes outside lib/data and a second end-of-day clock.
// These scans fail when a second copy appears; they read source text, so a failure names file and line.
// 
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(SRC, rel)).isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

const libHistory = sourceFiles("lib/history");
const componentsHistory = sourceFiles("components/history");
const watched = [...libHistory, ...componentsHistory, "components/useBlockHistory.tsx"];

/** Source with comment-only lines removed, as [line number, text]. */
function codeLines(file: string): Array<[number, string]> {
  return readFileSync(join(SRC, file), "utf8").split("\n")
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => !/^\s*(\/\/|\/\*|\*)/.test(text));
}

function offenders(files: string[], pattern: RegExp, allowed: readonly string[] = []): string[] {
  return files.filter((f) => !allowed.includes(f)).flatMap((file) =>
    codeLines(file).filter(([, text]) => pattern.test(text)).map(([n, text]) => `${file}:${n}: ${text.trim()}`));
}

// No exceptions today. If one is ever needed, name the file and the reason here, next to the rule.

describe("History says each thing once (frontend)", () => {
  it("scans the History files", () => {
    expect(libHistory).toEqual(expect.arrayContaining(["lib/history/index.ts", "lib/history/takeBack.ts", "lib/history/blockHistory.ts"]));
    expect(componentsHistory).toEqual(expect.arrayContaining(["components/history/WorkspaceHistoryUndoCard.tsx", "components/history/RewindConfirm.tsx"]));
  });

  it("paragraphs: no Markdown block regex (heading, list marker, fence, ^id) — cutting, pairing and counting are @onden/markdown's paragraphs.ts", () => {
    expect(offenders(watched, /#\{1,6\}|~~~|\[-\*\+\]|\\\^|A-Za-z0-9-\]\{1,64\}/)).toEqual([]);
    expect(offenders(watched, /function\s+(splitParagraphs|alignParagraphs|summarizeChange|summarizeAlignment|normalizeParagraph|isListItem)\b/)).toEqual([]);
    expect(offenders(["lib/history/index.ts"], /splitBlockParagraphs/)).toEqual([]);
  });

  it("History lib has no write of its own: no sendWrite (writes are historyWriter's, lib/data/noteHistoryWriter.ts)", () => {
    expect(offenders(libHistory, /\bsendWrite\b/)).toEqual([]);
    expect(offenders(componentsHistory, /\bsendWrite\b/)).toEqual([]);
  });

  it("History components write only through historyWriter: no api() / fetch() / queueWrite", () => {
    expect(offenders([...componentsHistory, ...libHistory], /\bfetch\(|\bqueueWrite\b|\bapi\(|\bapi<|\{\s*api\s*[,}]/)).toEqual([]);
  });

  it("the undo flow (pick notes → confirm → undo → result) lives in WorkspaceHistoryUndoCard only: the run and rewind cards hold no state", () => {
    expect(offenders(["components/history/WorkspaceHistoryRunCard.tsx", "components/history/WorkspaceHistoryRewindCard.tsx"], /\buse(State|Reducer|Effect)\b/)).toEqual([]);
    expect(offenders(componentsHistory, /\b(undoAgentRun|redoAgentRun|undoRewind)\b/, [
      "components/history/WorkspaceHistoryRunCard.tsx", "components/history/WorkspaceHistoryRewindCard.tsx",
    ])).toEqual([]);
  });

  it("the end of a day is the server's FeedDay.end_at: no second clock", () => {
    expect(offenders([...watched, "lib/localDate.ts"], /endOfDayInstant/)).toEqual([]);
    expect(offenders(["lib/history/workspaceHistoryApi.ts"], /\bend_at\?|\brewinds\?:/)).toEqual([]);
  });

  it("the guard scans real code", () => {
    expect(offenders(["lib/history/index.ts"], /@onden\/markdown/)).not.toEqual([]);
  });
});
