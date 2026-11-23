import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(SRC, file), "utf8");

// The space's switch is called 「AI 可以讀」. Every other sentence that names it uses the same words
// (the owner found 「可以送給 AI」 in the AI panel next to a switch called something else).
const FILES = readdirSync(SRC, { recursive: true }).map((f) => String(f).replace(/\\/g, "/")).filter((f) => /strings\.zh-TW\.ts$|i18n\.zh-TW\.\w+\.ts$/.test(f));
const OLD = ["可以送給 AI", "讓 AI 讀", "不讓 AI 讀", "不讓筆記送", "允許 AI 讀取", "開放 AI 讀取"];

describe("one name for the switch that lets AI read a space", () => {
  it("finds the zh strings files", () => { expect(FILES).toContain("lib/i18n.zh-TW.late.ts"); });
  for (const file of FILES) {
    it(`${file} has no other name for it`, () => {
      const text = read(file);
      for (const old of OLD) expect(text, old).not.toContain(old);
    });
  }
  it("the switch itself is still 「AI 可以讀」", () => {
    expect(read("lib/i18n.zh-TW.late.ts")).toContain('"AI can read": "AI 可以讀"');
  });
});
