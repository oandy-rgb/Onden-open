// Property (scan 15, M8): every code an undo can be refused with (the RestoreError
// union of backend services/restoreContract.ts, read from the file so a new code
// cannot be forgotten) has its own plain words, in both languages: not the
// generic server error, not the code itself, and in zh-TW not left in English.
// Seed and run count from PROPS_SEED / PROPS_RUNS.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { ensureWordingFor, serverErrorMessage } from "../../lib/serverErrors";
import { setLocalePref } from "../../lib/i18n";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const contract = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../backend/src/services/restoreContract.ts");
const union = readFileSync(contract, "utf8").split("export type RestoreError")[1]!.split(/;\s*\n\n|;\s*\n(?=export)/)[0]!;
const CODES = [...new Set([...union.matchAll(/code:\s*"([a-z_]+)"/g)].map((m) => m[1]!))].filter((c) => c !== "not_found");

afterEach(() => setLocalePref("system"));
// The rarer codes' wording loads on use (readErrorBody does this before an ApiError is built).
beforeAll(() => ensureWordingFor("patch_conflict"));

describe("undo refusal codes", () => {
  it("the scan finds the codes", () => {
    expect(CODES).toEqual(expect.arrayContaining(["patch_conflict", "state_conflict", "already_in_state", "target_gone", "irreversible", "external", "unsupported", "history_incomplete"]));
  });

  it("each has its own plain words in both languages", () => {
    fc.assert(fc.property(fc.constantFrom(...CODES), fc.constantFrom("en", "zh-TW" as const), (code, locale) => {
      setLocalePref(locale as "en" | "zh-TW");
      const generic = serverErrorMessage("internal", undefined);
      const text = serverErrorMessage(code, undefined);
      expect(text, `${locale} ${code}`).not.toBe(generic);
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
      if (locale === "zh-TW") expect(text, code).toMatch(/[一-鿿]/);
    }), { seed: PROPS_SEED, numRuns: Math.max(PROPS_RUNS, CODES.length * 2) });
  });

  it("M8: a refused undo (patch_conflict) is not shown as a server error", () => {
    setLocalePref("zh-TW");
    expect(serverErrorMessage("patch_conflict", undefined)).not.toBe(serverErrorMessage("internal", undefined));
  });
});
