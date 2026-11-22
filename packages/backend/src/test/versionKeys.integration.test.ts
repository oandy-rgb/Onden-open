// A `g:` / `b:` key is the same whether SQL (migration 220, the backfill) or JS (spine/noteVersions.ts, history a backup carries in)
// computes it (docs/architecture/proposals/history-replication-2026-11-22.md §4.4 point 9; review of PR #1935 round 2, point 9):
// each field `<UTF-8 bytes>:<text>`, a missing one `-`, the time as UTC microsecond text. The inputs below are the ones a plain
// separator gets wrong: an empty title against none, a field that ends with what the next begins with, non-ASCII titles (bytes, not
// characters), a title that is "-", two saves in one microsecond.
// realPostgresAlso: the commit-time checks read content putBlob committed on its own connection, and the save path spans two connections on a server
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { q } from "../db.js";
import { legacyVersionKey, type VersionUnit } from "../spine/noteVersions.js";
import { isImportedAt } from "../spine/importedHistory.js";
import { checkAsync } from "./helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const NOTE = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
type Input = { unit: VersionUnit; kind: string; hash: string | null; title: string | null; at: string };
const sqlKey = async (i: Input) => (await q<{ k: string }>(`SELECT note_version_legacy_key($1::uuid, $2, $3, $4, $5, $6) AS k`, [NOTE, i.unit, i.kind, i.hash, i.title, i.at])).rows[0]!.k;

const cases: Input[] = [
  { unit: "body", kind: "updated", hash: "a".repeat(64), title: "", at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "updated", hash: "a".repeat(64), title: null, at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "updated", hash: null, title: "", at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "updated", hash: "", title: null, at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "created", hash: "b".repeat(64), title: "-", at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "created", hash: "b".repeat(64), title: "1:-", at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "created", hash: "b".repeat(64), title: "會議紀錄 👨‍👩‍👧 é", at: "2026-11-21T08:00:00.000001Z" },
  { unit: "body", kind: "created", hash: "b".repeat(64), title: "會議紀錄 👨‍👩‍👧 é", at: "2026-11-21T08:00:00.000002Z" },
  { unit: "ink_data", kind: "removed", hash: null, title: null, at: "1999-12-31T23:59:59.999999Z" },
];

describe.skipIf(!isTestDb)("a version key, SQL and JS", () => {
  it("the same key for the cases a separator gets wrong, and different keys where any field differs", async () => {
    const keys: string[] = [];
    for (const c of cases) {
      const js = legacyVersionKey(NOTE, c.unit, c.kind, c.hash, c.title, c.at);
      expect(await sqlKey(c), JSON.stringify(c)).toBe(js);
      keys.push(js);
    }
    expect(new Set(keys).size).toBe(cases.length);
    // the SQL time text is the one IMPORTED_AT names
    expect((await q<{ t: string }>(`SELECT note_version_at(timestamptz '2026-11-21 16:00:00.000001+08') AS t`)).rows[0]!.t).toBe("2026-11-21T08:00:00.000001Z");
  });

  it("a carried version's time is taken only in the text Postgres gives back unchanged (round 1, point 10): no second 60, no hour 24", async () => {
    // what a backup's history line may carry (services/backupHistory.ts reads `at` through isImportedAt): where Postgres would normalise
    // the text (23:59:60 → next minute, 24:00 → next day), JS and SQL would name different keys, so such a line is refused
    for (const at of ["2026-11-21T23:59:60.000000Z", "2026-11-21T24:00:00.000000Z", "2026-02-30T08:00:00.000000Z", "2026-11-21T08:00:00.00001Z", "2026-11-21T08:00:00.000001+00:00"]) {
      expect(isImportedAt(at), at).toBe(false);
    }
    for (const at of ["2026-11-21T08:00:00.000001Z", "2024-02-29T23:59:59.999999Z", "1999-12-31T00:00:00.000000Z"]) {
      expect(isImportedAt(at), at).toBe(true);
      expect((await q<{ t: string }>(`SELECT note_version_at($1::timestamptz) AS t`, [at])).rows[0]!.t, at).toBe(at);
    }
  });

  it("property: random titles and hashes give the same key in SQL and JS", async () => {
    await checkAsync(fc.asyncProperty(
      fc.option(fc.string({ unit: "grapheme", maxLength: 40 }), { nil: null }), fc.option(fc.string({ maxLength: 70 }), { nil: null }),
      async (title, hash) => {
        const input: Input = { unit: "body", kind: "updated", hash, title, at: "2026-11-21T08:00:00.123456Z" };
        expect(await sqlKey(input)).toBe(legacyVersionKey(NOTE, "body", "updated", hash, title, input.at));
      }), 60);
  });
});
