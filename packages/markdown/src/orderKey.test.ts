import { describe, expect, it } from "vitest";
import { ORDER_KEY_RESPACE_LENGTH, compareOrdered, evenOrderKeys, isValidOrderKey, keyBetween, keysBetween, orderKeyNeedsRespace } from "./orderKey";

const sorted = (keys: string[]) => keys.every((k, i) => i === 0 || keys[i - 1]! < k);

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe("keyBetween", () => {
  it("starts at a0 and goes either way from a key", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    expect(keyBetween("a0", "a1")).toBe("a0V");
  });

  it("is strictly between and never equal to a side (random neighbours)", () => {
    const next = rng(7);
    const keys = ["a0"];
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(next() * (keys.length + 1));
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      expect(isValidOrderKey(key)).toBe(true);
      keys.splice(at, 0, key);
    }
    expect(sorted(keys)).toBe(true);
  });

  it("refuses keys that are out of order or malformed", () => {
    expect(() => keyBetween("a1", "a0")).toThrow();
    expect(() => keyBetween("a1", "a1")).toThrow();
    expect(isValidOrderKey("a10")).toBe(false);
    expect(isValidOrderKey("")).toBe(false);
    expect(isValidOrderKey("a-")).toBe(false);
    expect(isValidOrderKey(5)).toBe(false);
    expect(isValidOrderKey("A" + "0".repeat(26))).toBe(false);
  });
});

describe("keysBetween", () => {
  it("gives n increasing keys inside the gap, also on open sides", () => {
    for (const [a, b] of [[null, null], ["a0", null], [null, "a0"], ["a0", "a1"], ["a0V", "a1"]] as const) {
      for (const n of [0, 1, 2, 5, 100]) {
        const keys = keysBetween(a, b, n);
        expect(keys).toHaveLength(n);
        expect(sorted([...(a ? [a] : []), ...keys, ...(b ? [b] : [])])).toBe(true);
      }
    }
  });
  it("evenOrderKeys are valid, increasing and one character from any neighbour", () => {
    const keys = evenOrderKeys(5000);
    expect(sorted(keys)).toBe(true);
    expect(keys.every(isValidOrderKey)).toBe(true);
    expect(keyBetween(keys[10]!, keys[11]!).length).toBe(keys[10]!.length + 1);
  });
});

describe("bounded growth over 10,000 inserts", () => {
  function longest(place: (keys: string[]) => number, respace: boolean) {
    let keys: string[] = ["a0"];
    let longestKey = 0;
    for (let i = 0; i < 10_000; i++) {
      const at = place(keys);
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      keys.splice(at, 0, key);
      longestKey = Math.max(longestKey, key.length);
      if (respace && orderKeyNeedsRespace(key)) keys = evenOrderKeys(keys.length);
    }
    expect(sorted(keys)).toBe(true);
    return longestKey;
  }
  it("at the front, at the back, and always in the same gap", () => {
    const front = longest(() => 0, false);
    const back = longest((k) => k.length, false);
    const gap = longest(() => 1, false);
    const gapRespaced = longest(() => 1, true);
    console.info(`longest key in 10,000 inserts: front ${front}, back ${back}, same gap ${gap} (with respace at ${ORDER_KEY_RESPACE_LENGTH}: ${gapRespaced})`);
    expect(front).toBeLessThan(10);
    expect(back).toBeLessThan(10);
    expect(gapRespaced).toBeLessThanOrEqual(ORDER_KEY_RESPACE_LENGTH + 1);
  });
});

describe("compareOrdered", () => {
  it("orders by key, then stamp, then id, by code unit", () => {
    const rows = [
      { id: "b", order_key: "a0", order_stamp: "2" }, { id: "a", order_key: "a0", order_stamp: "2" },
      { id: "z", order_key: "a0", order_stamp: "1" }, { id: "k", order_key: "Zz" }, { id: "n", order_key: "a0", order_stamp: "" },
    ];
    expect([...rows].sort(compareOrdered).map((r) => r.id)).toEqual(["k", "n", "z", "a", "b"]);
  });
});
