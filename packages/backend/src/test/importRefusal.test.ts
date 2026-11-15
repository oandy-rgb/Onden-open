// An import skips a row only when that row was refused (no permission, out of
// scope, duplicate). Any other failure stops the import instead of being
// counted as a skipped row.
import { describe, expect, it } from "vitest";
import { isImportRefusal } from "../services/importRefusal.js";
import { AuthorityError } from "../spine/authority.js";

describe("isImportRefusal", () => {
  it("treats a permission refusal and a duplicate key as a skipped row", () => {
    expect(isImportRefusal(new AuthorityError("role", "denied"))).toBe(true);
    expect(isImportRefusal(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });
  it("treats anything else as a real failure", () => {
    expect(isImportRefusal(new Error("connection terminated"))).toBe(false);
    expect(isImportRefusal(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(false);
    expect(isImportRefusal(null)).toBe(false);
  });
});
