// Property: a refusal the backend sends as an English sentence (a StatusError,
// NodeTrashError, … with no code, or `error: "<sentence>"`) never reads as
// "the server broke" (audit 19 M1). The sentences are read from the backend's
// source, so a new one without wording fails here; fixed cases pin the three
// refusals that used to fall through. Seed and run count from PROPS_SEED / PROPS_RUNS.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { ApiError } from "../../lib/api";
import { setLocalePref } from "../../lib/i18n";
import { ensureSentenceWording, serverErrorMessage } from "../../lib/serverErrors";

afterEach(() => setLocalePref("en"));

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../backend/src");
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "test" || name === "vendor" ? [] : sourceFiles(path);
  return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
});

// Error classes that answer `{ error: <message> }` (httpError.ts), and the
// string literal that is the message: after the status for StatusError-style
// classes, first for the rest.
const SENTENCE_CLASSES = "StatusError|NodeUpdateError|NodeTrashError|TagMembershipError|ModuleLibraryError|AgentRunError|ReviewError|FunctionRefError|BlockLinkError|NotCalendarError";
const SCANS = [
  /\berror:\s*(["`])((?:(?!\1)[^\\\n]|\\.)*)\1/g,
  new RegExp(`new (?:${SENTENCE_CLASSES})\\(\\s*(?:[\\w.]+\\s*,\\s*)?(["\`])((?:(?!\\1)[^\\\\\\n]|\\\\.)*)\\1`, "g"),
  /\bsuper\(\s*\d+\s*,\s*(["`])((?:(?!\1)[^\\\n]|\\.)*)\1\s*\)/g,
];
// A log field, not a response.
const NOT_A_RESPONSE = /^catchup: /;
const NOT_FOUND = /^[a-z][a-z ]* not found$/;

function backendSentences(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(backend)) {
    const text = readFileSync(file, "utf8");
    for (const scan of SCANS) {
      for (const m of text.matchAll(scan)) {
        const sentence = m[2]!.replace(/\$\{[^}]*\}/g, "x");
        if (sentence.includes(" ") && !NOT_A_RESPONSE.test(sentence)) found.add(sentence);
      }
    }
  }
  return [...found];
}

const sentences = backendSentences();
beforeAll(async () => { await ensureSentenceWording(JSON.stringify({ error: "node is not deleted" })); });
const generic = (locale: "en" | "zh-TW") => { setLocalePref(locale); return serverErrorMessage("internal", undefined); };

describe("refusals sent as an English sentence", () => {
  it("the scan still finds them", () => {
    expect(sentences.length).toBeGreaterThan(60);
    expect(sentences).toContain("node is not deleted");
  });

  it("every one has its own wording, not the generic server message", () => {
    const bare: string[] = [];
    for (const locale of ["en", "zh-TW"] as const) {
      const words = generic(locale);
      for (const sentence of sentences) {
        if (NOT_FOUND.test(sentence)) continue;
        if (serverErrorMessage(sentence, undefined) === words) bare.push(`${locale}: ${sentence}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("any sentence, in any order and with any changing part, never reads as a server fault", () => {
    const words = { en: generic("en"), "zh-TW": generic("zh-TW") };
    fc.assert(fc.property(fc.constantFrom(...sentences), fc.constantFrom("en", "zh-TW" as const), fc.string({ maxLength: 8 }), (sentence, locale, tail) => {
      setLocalePref(locale);
      // A "<prefix>: <thing>" sentence keeps its wording whatever the thing is.
      const input = /: \S+$/.test(sentence) ? sentence.replace(/\S+$/, tail || "x") : sentence;
      if (NOT_FOUND.test(input)) return;
      expect(serverErrorMessage(input, undefined)).not.toBe(words[locale]);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });

  it("every one reads in Chinese in the zh-TW app, not in the server's English", () => {
    setLocalePref("zh-TW");
    const english = sentences.filter((sentence) => !NOT_FOUND.test(sentence) && !/[一-鿿]/.test(serverErrorMessage(sentence, undefined)));
    expect(english).toEqual([]);
  });

  // Fixed minimal cases: what a second device, a stale tree and a full list used to show.
  it.each([
    [409, "node is not deleted", "這篇筆記已經不在已刪除裡了。"],
    [400, "cannot move a node under its own descendant", "筆記不能移到自己的子筆記底下。"],
    [409, "too many calendars", "行事曆數量已達上限，請先移除一個。"],
    [422, "Failed to fetch feed: HTTP 404", "這個網址讀不到訂閱內容，請確認它是 RSS 或 Atom 網址。"],
  ])("%i %s reads in plain words", (status, error, expected) => {
    setLocalePref("zh-TW");
    expect(new ApiError(status, JSON.stringify({ error })).message).toBe(expected);
  });

  it("a move refused as a cycle is worded by its code (parent_cycle), which the server now keeps", () => {
    setLocalePref("zh-TW");
    const body = JSON.stringify({ error: "parent_cycle", detail: "cannot move a node under its own descendant" });
    expect(new ApiError(400, body).message).toBe("不能把筆記移到自己的子筆記底下");
  });
});
