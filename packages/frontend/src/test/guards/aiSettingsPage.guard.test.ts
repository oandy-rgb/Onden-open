// @vitest-environment node
// 設定 › AI (owner decision 2026-11-10): the whole page — its wording (settings/ai/strings.zh-TW.ts, and the English
// keys in its source) — names no AI company, product or model family, and the page has no default model: the models
// offered come only from what a connection itself reports. The repo-wide guard (aiVendorNames.guard.test.ts) covers
// company names everywhere; this one adds the model-family words and is aimed at this page, so a new string here
// fails with the page's own name on it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VENDOR_NAMES } from "../../../../../scripts/lib/vendorNames.mjs";
import { AI_SETTINGS_ZH_TW } from "../../settings/ai/strings.zh-TW";

const DIR = resolve(__dirname, "../../settings/ai");
const files = readdirSync(DIR).filter((name) => /\.(ts|tsx|css)$/.test(name));
/** Model families by name, which the company-name list does not carry. */
const MODEL_FAMILIES = /\b(sonnet|opus|haiku|gemma|grok|o[134]-(mini|preview)|command-r|phi-\d|titan|nova|palm)\b/i;
const named = (text: string) => VENDOR_NAMES.test(text) || MODEL_FAMILIES.test(text);

describe("設定 › AI names no company, product or model family", () => {
  it("the page's zh-TW wording, keys and values, names none", () => {
    const hits = Object.entries(AI_SETTINGS_ZH_TW).filter(([key, value]) => named(`${key} ${value}`)).map(([key]) => key);
    expect(hits).toEqual([]);
  });

  it("no source file of the page names one (its English keys are in the source)", () => {
    const hits = files.flatMap((name) => readFileSync(join(DIR, name), "utf8").split("\n")
      .flatMap((line, i) => (named(line) ? [`${name}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("no source file of the page writes a model id as a default (the list comes from the connection)", () => {
    const hits = files.filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
      .flatMap((name) => readFileSync(join(DIR, name), "utf8").split("\n")
        .flatMap((line, i) => (/\bmodel\s*[:=]\s*["'][a-z0-9][\w.:-]*["']/i.test(line) && !/model:\s*""/.test(line) ? [`${name}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("scans the page (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(Object.keys(AI_SETTINGS_ZH_TW).length).toBeGreaterThan(70);
  });
});
