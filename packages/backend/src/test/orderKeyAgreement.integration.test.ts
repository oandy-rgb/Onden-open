// The database and JavaScript order keys the same way: by byte, with the stamp and the id breaking ties. A locale collation
// would put "a0" before "Zz"; the keys' own order (and the sort in the browser) puts "Zz" first.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect } from "vitest";
import { compareOrdered, evenOrderKeys, keyBetween, keysBetween } from "@onden/markdown/contract";
import { q } from "../db.js";
import { SIBLING_ORDER_N } from "../services/orderKeys.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe.skipIf(!isTestDb)("order keys: SQL and JS agree (DB)", () => {
  it("plain byte order of random keys is the same in COLLATE \"C\" and in JS", async () => {
    const next = rng(11);
    const keys = ["a0"];
    for (let i = 0; i < 2500; i++) {
      const at = Math.floor(next() * (keys.length + 1));
      keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
    }
    // Both signs of the integer part, both ends, and a long run in one gap.
    keys.push(...keysBetween(null, keys[0]!, 200), ...keysBetween(keys.at(-1)!, null, 200), ...evenOrderKeys(5000));
    const shuffled = [...new Set(keys)].sort(() => next() - 0.5);
    const sql = (await q<{ k: string }>(`SELECT k FROM unnest($1::text[]) AS t(k) ORDER BY k COLLATE "C"`, [shuffled])).rows.map((r) => r.k);
    expect(sql).toEqual([...shuffled].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(sql.some((k, i) => i > 0 && sql[i - 1]! >= k)).toBe(false);
  });

  it("the sibling ORDER BY (key, stamp, id) equals compareOrdered, ties included", async () => {
    const next = rng(5);
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(Math.floor(next() * 1e12)).padStart(12, "0")}`,
      order_key: ["a0", "a1", "Zz", "a0V", "b00"][Math.floor(next() * 5)]!,
      order_stamp: ["", "000001700000000000000000", "000001700000000000000001"][Math.floor(next() * 3)]!,
    }));
    void rows.length;
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    const sql = (await q<{ id: string }>(
      `SELECT n.id::text FROM (SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, order_key, order_stamp)) n ORDER BY ${SIBLING_ORDER_N}`,
      [unique.map((r) => r.id), unique.map((r) => r.order_key), unique.map((r) => r.order_stamp)],
    )).rows.map((r) => r.id);
    expect(sql).toEqual([...unique].sort(compareOrdered).map((r) => r.id));
  });
});
