// changes/ is what users read as 「這次更新」 (changes/README.md): every file must
// parse, and none may carry the technical words the UI rule keeps out of the interface.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChange } from "../../lib/whatsNew";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "changes");
const files = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");

// PR numbers, hashes, file names and code, API paths, snake_case and constants.
const TECHNICAL = /#\d+|\b[0-9a-f]{7,40}\b|\.(tsx?|mjs|sql|json|md)\b|`|\/api\/|\b[a-z]+_[a-z_]+\b|\b[A-Z]{2,}_[A-Z_]+\b|\bPR\b|migration|commit/i;

/** A note's day, against `todayUtc`: later than that and an account that marks it seen skips every note added before its day passes. */
const futureDated = (names: readonly string[], todayUtc: string): string[] => names.filter((name) => name.slice(0, 10) > todayUtc);

describe("changes/*.md dates", () => {
  // Who sees the card no longer depends on the date (hooks/useUnseenChanges compares instants), but the date is the id,
  // and an account's "seen up to" is an id: a note dated tomorrow, once seen, hides every note that lands before tomorrow.
  it("catches a note dated after today's UTC day", () => {
    expect(futureDated(["2026-11-17-a.md", "2026-11-18-b.md"], "2026-11-17")).toEqual(["2026-11-18-b.md"]);
    expect(futureDated(["2026-11-17-a.md"], "2026-11-17")).toEqual([]);
  });
  it("has no note dated after today's UTC day", () => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    expect(futureDated(files, todayUtc),
      `changes/ 的日期要用「UTC 的今天」（${todayUtc}），不是你所在時區的日期：日期就是這則說明的排序編號，寫成還沒到的日子，看過它的帳號之後就看不到比它早的新說明。請把檔名與 date 都改成 ${todayUtc}。`).toEqual([]);
  });
});

describe("changes/*.md", () => {
  it("has at least one file", () => { expect(files.length).toBeGreaterThan(0); });
  for (const name of files) {
    it(`${name} parses and reads in plain words`, () => {
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
      const source = readFileSync(join(dir, name), "utf8");
      const change = parseChange(name.replace(/\.md$/, ""), source);
      expect(change, "needs date and zh-TW, and the name must start with the date").not.toBeNull();
      for (const text of [change!.zh, change!.en ?? ""]) expect(text).not.toMatch(TECHNICAL);
    });
  }
});
