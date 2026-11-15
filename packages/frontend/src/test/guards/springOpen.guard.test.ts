// @vitest-environment node
// Guard: the sidebar drag's spring-open timer (hold a note over a folded row → it opens) is lib/springOpen's,
// owned by hooks/useSidebarDrag, so the tree and the tag list wait the same time and fold back the same way.
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"), ...sourceFiles("pages")];

describe("spring-open is lib/springOpen's", () => {
  it("only hooks/useSidebarDrag creates one", () => {
    expect(findUses(files, /\bcreateSpringOpen\(/, ["lib/springOpen.ts", "hooks/useSidebarDrag.ts"]), entryHint("spring-open")).toEqual([]);
  });
});
