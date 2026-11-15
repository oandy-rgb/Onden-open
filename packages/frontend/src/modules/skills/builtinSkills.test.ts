import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_SKILL_TEXT } from "./builtinSkills";
import { ZH_TW } from "../../lib/i18n.zh-TW";

// The built-in skills' display text is keyed by the server's ids; a skill the
// backend adds without an entry here would show its English wire name. The
// i18n key check can't see these (they are looked up by id), so pin both.
const backend = readFileSync(resolve(__dirname, "../../../../backend/src/services/harness/builtinSkills.ts"), "utf8");
const backendIds = [...backend.matchAll(/^\s*id: "([a-z_]+)",/gm), ...backend.matchAll(/textSkill\("([a-z_]+)"/g)].map((m) => m[1]!);

describe("built-in skill text", () => {
  it("covers every built-in skill the backend defines", () => {
    expect(backendIds.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(BUILTIN_SKILL_TEXT).sort()).toEqual([...new Set(backendIds)].sort());
  });

  it("has zh-TW text for each name and description", () => {
    for (const [id, text] of Object.entries(BUILTIN_SKILL_TEXT)) {
      expect(ZH_TW[text.name()], `${id} name`).toBeTruthy();
      expect(ZH_TW[text.description()], `${id} description`).toBeTruthy();
    }
  });
});
