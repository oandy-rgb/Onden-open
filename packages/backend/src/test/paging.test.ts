// services/paging.ts — the one limit/offset grammar (D66).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_OFFSET, pageOf, pageSql, parsePage, safeParsePage } from "../services/paging.js";

const OPTS = { default: 100, max: 200 };

describe("parsePage", () => {
  it("absent or blank → the default limit and offset 0", () => {
    expect(parsePage({}, OPTS)).toEqual({ limit: 100, offset: 0 });
    expect(parsePage({ limit: " ", offset: "" }, OPTS)).toEqual({ limit: 100, offset: 0 });
    expect(parsePage({ limit: null, offset: null }, OPTS)).toEqual({ limit: 100, offset: 0 });
  });

  it("a limit over max is clamped; an in-range one is kept", () => {
    expect(parsePage({ limit: "999" }, OPTS).limit).toBe(200);
    expect(parsePage({ limit: "25", offset: "50" }, OPTS)).toEqual({ limit: 25, offset: 50 });
  });

  it.each(["abc", "-5", "0", "1.5", "10abc", "1e3"])("limit=%s throws a ZodError (→ 400)", (limit) => {
    expect(() => parsePage({ limit }, OPTS)).toThrow(z.ZodError);
  });

  it.each(["x", "-1", "2.5", String(MAX_OFFSET + 1)])("offset=%s throws a ZodError (→ 400)", (offset) => {
    expect(() => parsePage({ offset }, OPTS)).toThrow(z.ZodError);
  });

  it("safeParsePage returns the message instead of throwing", () => {
    expect(safeParsePage({ limit: "abc" }, OPTS)).toEqual({ ok: false, error: "limit must be a positive integer" });
    expect(safeParsePage({ limit: "3" }, OPTS)).toEqual({ ok: true, page: { limit: 3, offset: 0 } });
  });
});

describe("pageSql / pageOf", () => {
  it("binds LIMIT (with the probe row) and OFFSET as parameters", () => {
    const params: unknown[] = ["ws"];
    expect(pageSql({ limit: 10, offset: 20 }, params)).toBe("LIMIT $2 OFFSET $3");
    expect(params).toEqual(["ws", 11, 20]);
  });

  it("drops the probe row and gives the next offset; null on the last page", () => {
    expect(pageOf([1, 2, 3], { limit: 2, offset: 4 }, 9)).toEqual({ rows: [1, 2], total: 9, next: 6 });
    expect(pageOf([1, 2], { limit: 2, offset: 0 })).toEqual({ rows: [1, 2], next: null });
  });
});
