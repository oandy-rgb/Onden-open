// @vitest-environment node
// Guard for dedupe batch 2, wording (docs/research/dup-patterns-2026-10-30-render.md B3, B4, B6, B7).
// Allowlist, deny by default; an exception says why, and one that no longer applies fails, so the lists
// only shrink. Rules about what a sentence says are written here, in this file.
import { describe, expect, it } from "vitest";
import { ZH_TW } from "../../lib/i18n.zh-TW";
import { findUses, sourceFiles } from "./sources";

const files = sourceFiles(".").filter((file) => !/lib\/i18n\.zh-TW(\.boot|\.late)?\.ts$/.test(file));
const keys = Object.keys(ZH_TW);

/** Keys that say an action needs a connection, but not as one full sentence with its period (B3). */
function unfinishedOfflineSentences(dictionary: Record<string, string>, except: readonly string[]): string[] {
  return Object.entries(dictionary)
    .filter(([key, value]) => / needs a connection\.?$/.test(key) && !except.includes(key) && (!key.endsWith(".") || !value.endsWith("。") || value.includes("網路連線")))
    .map(([key, value]) => `${key} => ${value}`);
}

describe("B3 — \"needs a connection\" is one sentence shape", () => {
  // Their caller (lib/data/taskWriter.ts) is being edited in an open PR; add the period there and delete these.
  const IN_OPEN_PR = ["Putting a task into a note needs a connection", "Taking a task out of a note needs a connection"];

  it("every such key ends with a period, and its zh-TW value with 。 and says 需要連線", () => {
    expect(unfinishedOfflineSentences(ZH_TW, IN_OPEN_PR)).toEqual([]);
  });

  it("each exception is still in the dictionary without its period", () => {
    expect(IN_OPEN_PR.filter((key) => !(key in ZH_TW) || key.endsWith("."))).toEqual([]);
  });

  it("the check itself fires on what it forbids", () => {
    expect(unfinishedOfflineSentences({ "Undoing needs a connection": "復原需要連線。", "Sending needs a connection.": "送出需要網路連線。", "Publishing needs a connection.": "發布需要連線。" }, [])).toHaveLength(2);
  });
});

describe("B4 — copying says one thing", () => {
  it("the success words are \"Copied\" (a toast or a button label), never \"Copied to clipboard\" or \"Link copied\"", () => {
    expect(findUses(files, /\bt\(\s*["'](?:Copied to clipboard|Link copied)["']/)).toEqual([]);
    expect(keys.filter((key) => /^(?:Copied to clipboard|Link copied)$/.test(key))).toEqual([]);
  });

  it("the failure sentences are the few that say something different", () => {
    expect(keys.filter((key) => /^(?:Couldn't|Could not) copy/.test(key)).sort()).toEqual([
      "Could not copy. Download Markdown from the note menu instead.", // the way out is the download
      "Couldn't copy — copy the link yourself: {link}", // shows the link
      "Couldn't copy — select {what} and copy it manually.", // lib/clipboard.ts: the one for a field to select
    ].sort());
  });

  it("only lib/clipboard.ts touches navigator.clipboard", () => {
    expect(findUses(files, /navigator\.clipboard/, ["lib/clipboard.ts"])).toEqual([]);
  });
});

describe("B6 — the note size caps are said by serverErrors.ts, with numbers from @onden/markdown elsewhere", () => {
  const SERVER_ERRORS = ["lib/serverErrors.ts"];

  it("no other file spells the body cap or the title cap as a number", () => {
    expect(findUses(files, /2,000,000|2_000_000|\b500 characters/, SERVER_ERRORS)).toEqual([]);
  });

  it("the dictionary has them only in the two serverErrors sentences", () => {
    expect(keys.filter((key) => /2,000,000|\b500 characters/.test(key)).sort()).toEqual([
      "A note title can't be longer than 500 characters.",
      "This note is over the 2,000,000-character limit and can't be saved. Split it or shorten it.",
    ].sort());
  });
  // Still two codes for one condition (U+0000 "contains_nul" and a broken character "invalid_text"):
  // the backend files that spell them (noteSize.ts, utils.ts, routes/nodes.ts, the importers) and
  // lib/serverErrors.ts are in open PRs. Next batch: one code, one sentence.
});

describe("B7 — the AI is called \"AI\"", () => {
  it("no code says \"AI agent\" or \"AI assistant\" to a person (lib/actorLabel.ts's aiLabel / agentLabel)", () => {
    expect(findUses(files, /["'`](?:AI agent|AI assistant|requested by the AI agent)["'`]/)).toEqual([]);
    expect(keys.filter((key) => /^(?:AI agent|AI assistant|agent)$/.test(key))).toEqual([]);
  });

  it("only lib/actorLabel.ts words an unnamed AI actor with t(\"AI\")", () => {
    expect(findUses(files, /\bt\(\s*["']AI["']\s*\)/, [
      "lib/actorLabel.ts",
      "components/history/NoteHistory.tsx", // in an open PR: use agentLabel
      "components/history/WorkspaceHistoryChanges.tsx", // in an open PR: use agentLabel
    ])).toEqual([]);
  });

  it("a space member's AI mark is memberLabel's", () => {
    expect(findUses(files, /\(\$\{t\(["']AI["']\)\}\)|t\(["']\{name\} \(AI\)["']/, ["lib/actorLabel.ts"])).toEqual([]);
  });
});
