// @vitest-environment node
// Guard for the wording batch (docs/research/dup-patterns-2026-10-30-render.md B1, B2). Allowlist, deny by default:
//  - the words the owner ruled out (撤銷 保存 發佈 ⋯) appear in no zh-TW value and no string of the app;
//  - undo is 復原 and going back to an older version is 還原, in the dictionary's own keys;
//  - the sentence "saved on this device, syncs later" is written once (writeErrors.queuedMessage).
// An exception says why; one that no longer applies fails, so the lists only shrink.
import { describe, expect, it } from "vitest";
import { ZH_TW } from "../../lib/i18n.zh-TW";
import { findUses, sourceFiles } from "./sources";

// The dictionary is checked by value above; everything else is checked as code.
const files = sourceFiles(".").filter((file) => !/lib\/i18n\.zh-TW(\.boot|\.late)?\.ts$/.test(file));

const BANNED_WORDS = /撤銷|保存|發佈|⋯/;

/** `key => value` of every dictionary entry whose value has a ruled-out word. */
function bannedValues(dictionary: Record<string, string>): string[] {
  return Object.entries(dictionary).filter(([, value]) => BANNED_WORDS.test(value)).map(([key, value]) => `${key} => ${value}`);
}

/** Entries whose key is about undo but whose value has no 復原, or about restoring a version but has 復原 and no 還原. */
function driftedValues(dictionary: Record<string, string>, keepsUndoWord: readonly string[]): string[] {
  return Object.entries(dictionary).filter(([key, value]) => {
    if (/^(?:Undo|Undone|Undid|Undoing)\b/.test(key)) return !value.includes("復原");
    if (/^(?:Restore|Restored|Restoring)\b/.test(key) && !keepsUndoWord.includes(key)) return !value.includes("還原") || value.includes("復原");
    return false;
  }).map(([key, value]) => `${key} => ${value}`);
}

// A restore sentence that also says how to undo it has both words, each for its own act.
const BOTH_WORDS: Record<string, string> = {
  "Restore {n} notes into 「{space}」? Nothing already there is overwritten. You can undo the whole restore from History.": "restore, then undo it",
  "Restored. Undo it from History if needed.": "restore, then undo it",
};

describe("zh-TW wording the owner decided", () => {
  it("no value says 撤銷, 保存, 發佈 or ⋯ (復原 / 還原, 儲存, 發布, …)", () => {
    expect(bannedValues(ZH_TW)).toEqual([]);
  });

  it("Undo… is 復原; Restore… (an older version, a backup) is 還原, never 復原", () => {
    expect(driftedValues(ZH_TW, Object.keys(BOTH_WORDS))).toEqual([]);
    for (const key of Object.keys(BOTH_WORDS)) expect(ZH_TW[key], key).toMatch(/還原[^]*復原/);
  });

  it("no string in the app's code says 撤銷, 保存 or 發佈, and no sentence of it says ⋯", () => {
    expect(findUses(files, /撤銷|保存|發佈/)).toEqual([]);
    // A `t("… ⋯ …")` line is an English dictionary key, which stays as it is.
    expect(findUses(files, /^(?!.*\bt\r?\()(?!.*\buseT\b).*⋯/)).toEqual([]);
  });

  it("Revoke… is 作廢 (a token cannot be switched back on), never 停用, 撤銷 or 復原", () => {
    const wrong = (dictionary: Record<string, string>) => Object.entries(dictionary).filter(([key, value]) => /^(?:revoke|revoked|TOKEN_REVOKED)\b|^Revoke\b|^Tokens — mint and revoke/i.test(key) && (!value.includes("作廢") || /停用|撤銷|復原/.test(value)));
    expect(wrong(ZH_TW)).toEqual([]);
    expect(wrong({ "Revoke failed": "停用失敗" })).toHaveLength(1);
  });

  it("the check itself fires on what it forbids", () => {
    expect(bannedValues({ a: "已保存", b: "撤銷", c: "發佈", d: "更多⋯", e: "已儲存" })).toHaveLength(4);
    expect(driftedValues({ "Undo this": "撤銷這次", "Restore this version": "復原此版本", Restore: "還原" }, [])).toHaveLength(2);
  });
});

describe("the queued-save sentence is one key", () => {
  it("only writeErrors.ts words a save that waits on this device", () => {
    expect(findUses(files, /saved on this device|on this device — it will sync|will sync when you are back online/i, [
      "lib/data/writeErrors.ts",
      "modules/rss/RssReaderPanel.tsx", // a queued subscription (the server has not fetched the feed) and a queued add that names its note: not the same meaning
      "modules/rss/RssSourcesSheet.tsx", // a queued subscription: the server has not fetched the feed yet
      "components/FailedWriteRecovery.tsx", // the recovery copy: input that will not be sent again, not a queued save
    ])).toEqual([]);
  });

  it("the dictionary keeps one sentence for it (the recovery copy aside)", () => {
    const keys = Object.keys(ZH_TW).filter((key) => /saved on this device/i.test(key));
    expect(keys.sort()).toEqual([
      "Saved on this device — we'll subscribe when the server is reachable.",
      "Saved on this device — it will sync when the server is reachable.",
      "Your input is saved on this device and will not be sent again automatically. Copy it before removing this recovery copy.",
    ].sort());
  });
});
