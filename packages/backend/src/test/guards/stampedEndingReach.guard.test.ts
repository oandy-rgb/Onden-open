// The ending every bundle test has (helpers/stampedEnding.ts; issue #1976) sees a test's exchanges only through the wrapper test/stampedEndingSetup.ts puts around the
// receiving exports of spine/stampedImport.ts. Two ways it could stop seeing them without anything turning red, each closed here:
//   - a new export that writes what a node received (a new way in, as another batch may add) that nobody wraps: every function the module exports is either wrapped
//     (ENDING_WRAPPED, and each of those really is replaced in this file, which has the setup like every other) or named as writing nothing received, with why;
//   - a test file that mocks stampedImport.ts itself, which replaces the wrapper for that file: only the files in ENDING_OWN_MOCKS (shrink-only), each saying how it
//     records its calls.
// That the wrapper records and ends a real exchange is shown by stampedEndingAlive.integration.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as wrapped from "../../spine/stampedImport.js";
import { ENDING_NOT_RECEIVING, ENDING_WRAPPED, keysNamingNothing } from "../helpers/stampedEndingNames.js";
import { ENDING_FAILS, ENDING_LONG_SETTLE, ENDING_OWN_MOCKS, ENDING_SKIPPED } from "../helpers/stampedEndingExceptions.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "node_modules" ? [] : testFiles(path);
  return name.endsWith(".test.ts") ? [path] : [];
});

describe("the ending's wrapper reaches every way into the receiving side", () => {
  it("every function spine/stampedImport.ts exports is wrapped by the setup file or named as writing nothing received", async () => {
    const real = await vi.importActual<Record<string, unknown>>("../../spine/stampedImport.js");
    const functions = Object.keys(real).filter((k) => typeof real[k] === "function").sort();
    const named = [...ENDING_WRAPPED, ...Object.keys(ENDING_NOT_RECEIVING)];
    expect(functions.filter((f) => !named.includes(f)), "exports neither wrapped (stampedEndingSetup.ts, ENDING_WRAPPED) nor in ENDING_NOT_RECEIVING with a reason").toEqual([]);
    expect(named.filter((f) => !functions.includes(f)), "names in the lists that stampedImport.ts no longer exports").toEqual([]);
    expect(ENDING_WRAPPED.filter((f) => f in ENDING_NOT_RECEIVING), "named in both lists").toEqual([]);
    const mine = wrapped as unknown as Record<string, unknown>;
    expect(ENDING_WRAPPED.filter((f) => mine[f] === real[f]), "named as wrapped, but the setup file does not replace it").toEqual([]);
  });

  it("only the files in ENDING_OWN_MOCKS mock spine/stampedImport.ts themselves (which replaces the wrapper for the whole file)", () => {
    const mocking = testFiles(SRC).filter((f) => /vi\.(?:do)?[mM]ock\(\s*["'][^"']*\/stampedImport(?:\.js)?["']/.test(readFileSync(f, "utf8")))
      .map((f) => basename(f)).sort();
    expect(mocking.filter((f) => !(f in ENDING_OWN_MOCKS)), "mock stampedImport.ts and are not in ENDING_OWN_MOCKS (helpers/stampedEndingExceptions.ts)").toEqual([]);
    expect(Object.keys(ENDING_OWN_MOCKS).filter((f) => !mocking.includes(f)), "in ENDING_OWN_MOCKS but no longer mock it: take them out").toEqual([]);
  });
});

// An entry of the exception lists is found by the test's full name, so a test or describe renamed (as #1997 renamed a describe of stampedBundle that a " > *" entry
// pinned) leaves an entry that pins nothing, and the test under its new name runs with none. The setup file checks each file that ran against its own tests
// (keysNamingNothing); a file renamed or taken out runs no setup, so its entries are checked here.
describe("every entry of the ending's exception lists names a test that exists", () => {
  it("each entry's file is a test file", () => {
    const files = new Set(testFiles(SRC).map((f) => basename(f)));
    const lists = { ENDING_FAILS, ENDING_SKIPPED, ENDING_LONG_SETTLE };
    const missing = Object.entries(lists).flatMap(([list, entries]) => Object.keys(entries).filter((k) => !files.has(k.split(" > ")[0])).map((k) => `${list}: ${k}`));
    expect(missing, "entries whose file is no test file (renamed or taken out?)").toEqual([]);
  });

  it("keysNamingNothing reports an entry no test of the file has, and none that one has (its own name, a describe's \" > *\", outside a test)", () => {
    const tests = ["f.test.ts > d > t1", "f.test.ts > e > t2"];
    const lists = {
      L: { "f.test.ts > d > t1": 1, "f.test.ts > e > *": 1, "f.test.ts > (outside a test)": 1, "g.test.ts > x": 1, "f.test.ts > d > renamed": 1, "f.test.ts > old describe > *": 1 },
    };
    expect(keysNamingNothing("f.test.ts", tests, lists)).toEqual(['L: "f.test.ts > d > renamed"', 'L: "f.test.ts > old describe > *"']);
    expect(keysNamingNothing("f.test.ts", tests, { L: { "f.test.ts > d > t1": 1 } })).toEqual([]);
  });
});
