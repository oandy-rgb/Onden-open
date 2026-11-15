// @vitest-environment node
// The create list (lib/createKinds) holds only built-in kinds. A module's own
// add dialog (SKILL.md) is its `dialogEntry`, opened from the module's
// tag page and the palette; one file kind (upload) covers PDF, image, audio and
// video. This guards the slim-down against a module quietly adding a "+" row.
import { describe, expect, it } from "vitest";
import { BUILTIN_CREATE_KINDS } from "../../lib/createKinds";
import { MODULES } from "../../modules";
import { codeLines, sourceFiles } from "./sources";

describe("create list", () => {
  it("lists exactly the built-in kinds, with one upload for files", () => {
    expect(BUILTIN_CREATE_KINDS.map((k) => k.id)).toEqual(["note", "tag", "task", "ink", "upload", "bookmark", "canvas"]);
  });

  it("no module declares a create entry", () => {
    const uses = sourceFiles("modules").flatMap((file) => codeLines(file).flatMap((line, i) => /\bcreateEntry\b/.test(line) ? [`${file}:${i + 1}`] : []));
    expect(uses).toEqual([]);
  });

  it("the modules with an add dialog are the ones whose module tag opens it", () => {
    expect(MODULES.filter((m) => m.dialogEntry).map((m) => m.id)).toEqual(["skills"]);
  });
});
