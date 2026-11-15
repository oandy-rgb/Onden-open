// Property: `ORDER BY title` (the database's order, used wherever a list is
// sorted in SQL: tag lists, the export's file order, skill lists) is a total
// order on Chinese and Unicode titles, and equal titles stay together. WHICH
// order it is depends on the database's collation, not on the app: this test
// database's is printed in the test name and the PR lists the difference from
// the sidebar's `localeCompare` and the site's zh-Hant order for a decision
// (frontend test/properties/titleSort.property.test.ts). Seed and run count
// from PROPS_SEED / PROPS_RUNS. Skips unless DATABASE_URL names a *_test database.

import { describe, expect, it, beforeAll } from "vitest";
import fc from "fast-check";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { titleText } from "../../../../markdown/src/test/helpers/unicodeText.js";
import { q } from "../../db.js";

const enabled = isTestDatabase();

describe.skipIf(!enabled)("ORDER BY title on Chinese and Unicode titles", () => {
  let collation = "";
  beforeAll(async () => {
    collation = (await q<{ datcollate: string }>(`SELECT datcollate FROM pg_database WHERE datname = current_database()`)).rows[0]!.datcollate;
  });

  const sorted = async (titles: string[]) => (await q<{ t: string }>(`SELECT t FROM unnest($1::text[]) AS t ORDER BY t`, [titles])).rows.map((r) => r.t);

  it("sorts every list the same way twice, and a reversed list to the same order", async () => {
    await fc.assert(fc.asyncProperty(fc.array(titleText, { minLength: 2, maxLength: 20 }), async (titles) => {
      const once = await sorted(titles);
      expect(await sorted(once)).toEqual(once);
      expect(await sorted([...titles].reverse())).toEqual(once);
      expect([...once].sort()).toHaveLength(titles.length);
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });

  it("is antisymmetric: two titles are never each before the other", async () => {
    await fc.assert(fc.asyncProperty(titleText, titleText, async (a, b) => {
      const lt = (await q<{ lt: boolean; gt: boolean }>(`SELECT $1::text < $2::text AS lt, $1::text > $2::text AS gt`, [a, b])).rows[0]!;
      expect(lt.lt && lt.gt).toBe(false);
      if (a === b) expect(lt.lt || lt.gt).toBe(false);
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });

  it(`current behaviour: the database sorts by its collation (this database), not the sidebar's locale or zh-Hant`, async () => {
    const titles = ["蘋果", "香蕉", "筆記", "資料結構", "演算法", "作業", "專案", "會議", "日本語", "測試"];
    const order = await sorted(titles);
    // Same set; the position of each title is whatever the collation says.
    expect([...order].sort()).toEqual([...titles].sort());
    if (/^(C|POSIX|C\.UTF-8)$/i.test(collation)) expect(order).toEqual([...titles].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))));
  });
});
