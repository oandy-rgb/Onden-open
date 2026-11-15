import { describe, it, expect } from "vitest";
import { isTransientDbError } from "../dbErrors.js";

const withCode = (code: string) => Object.assign(new Error("x"), { code });

describe("isTransientDbError", () => {
  it.each(["40001", "40P01", "55P03", "53300", "57P01", "08006", "ECONNRESET", "ETIMEDOUT"])(
    "%s is transient", (code) => expect(isTransientDbError(withCode(code))).toBe(true),
  );
  it.each(["23505", "23503", "42601", "22P02", "P0001", "57014"])(
    "%s is deterministic", (code) => expect(isTransientDbError(withCode(code))).toBe(false),
  );
  it("recognises code-less pg client errors by message", () => {
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });
  it("looks through cause", () => {
    expect(isTransientDbError(new Error("wrapped", { cause: withCode("40001") }))).toBe(true);
  });
  it("plain errors and non-errors are not transient", () => {
    expect(isTransientDbError(new Error("boom"))).toBe(false);
    expect(isTransientDbError("40001")).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
