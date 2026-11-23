// Guard for the 2026-10-29 cross-package dedupe batch (docs/research/dup-sweep-2026-10-29-cross.md).
// Each rule below used to be written once per package. The owner is named in each case; a second
// definition anywhere in backend, frontend, site or markdown fails here. Exceptions say why.
import { describe, expect, it } from "vitest";
import { FILES } from "./sources";

/** Files whose code matches `pattern`, except the owner(s). */
function usesOutside(pattern: RegExp, owners: string[]): string[] {
  return FILES.filter((f) => pattern.test(f.text) && !owners.includes(f.path)).map((f) => f.path);
}

describe("values both sides agree on are defined once (sharedContract.ts)", () => {
  const OWNER = "markdown/src/sharedContract.ts";
  const NAMES = ["TASKS_MODULE_ID", "TASK_ATTR", "PUBLISHED_EDGE_TYPES", "REWIND_MAX_NOTES", "TAG_PAGE_ROWS_MAX", "PASSWORD_MIN_LENGTH", "PASSWORD_MAX_LENGTH", "BUILT_IN_FIELD_NAMES", "BUILT_IN_FIELDS", "FILTER_OP_NAMES", "TAG_NAME_MAX", "VIEW_NAME_MAX", "SPACE_NAME_MAX", "TASK_TITLE_MAX", "BROWSER_INK_HISTORY_LIMIT_BYTES"];

  it.each(NAMES)("%s is declared only in sharedContract.ts", (name) => {
    expect(usesOutside(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`), [OWNER]), "import it from @onden/markdown").toEqual([]);
  });

  it("the reserved _task_* attribute keys are spelled only there (the legacy `_task_due` read is not one of them)", () => {
    expect(usesOutside(/["'`]_task_(?:status|when|evening|someday|deadline|recur|recur_mode|remind_at)["'`]/, [OWNER])).toEqual([]);
  });

  it("the saved-view row fields and filter operators are not retyped as lists", () => {
    expect(usesOutside(/["']title["'],\s*["']slug["'],\s*["']updated_at["']/, [OWNER])).toEqual([]);
    expect(usesOutside(/["']empty["'],\s*["']nempty["']/, [OWNER])).toEqual([]);
  });

  it("the guard still sees the owner", () => {
    expect(FILES.find((f) => f.path === OWNER)?.text).toMatch(/\bconst\s+TASKS_MODULE_ID\b/);
  });
});

describe("what a UUID, a #rrggbb colour and a ^block-id look like is one definition each", () => {
  it("the 8-4-4-4-12 shape is spelled only by uuid.ts (use isUuid / UUID_SOURCE)", () => {
    expect(usesOutside(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/i, ["markdown/src/uuid.ts"])).toEqual([]);
  });

  it("a `#rrggbb` check is color.ts's isHexColor only (the wider ink colour lists are in ownership.guard.test.ts)", () => {
    expect(usesOutside(/#\[0-9a-f(?:A-F)?\]\{6\}/i, ["markdown/src/color.ts"])).toEqual([]);
  });

  it("the characters of a ^id come from BLOCK_ID_CHARS in backend and frontend, not a typed class", () => {
    const offenders = FILES.filter((f) => /^(?:backend|frontend)\//.test(f.path) && /\\\^\(?\[(?:A-Za-z0-9|a-zA-Z0-9)-?\]/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
