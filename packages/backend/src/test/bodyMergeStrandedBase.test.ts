// A client save whose merge base holds text the server never received. It happens after a page was killed while a
// note save was in flight: the typed text reached that device's local copy but no queue row (frontend
// localDbJournal.test.ts "a save the page died during"), so after a reopen the editor starts from it as if saved,
// and the next save sends it as `base_markdown`. The merge then reads "base -> current" as someone having deleted
// that text. This file pins what the server does with such a request; the merge itself is correct for the base
// it is given. Whole-body and patch saves reach the same merge: a patch on a base the server does not hold is
// answered `patch_base_unknown` and resent whole (frontend lib/data/patchedBody.ts).
import { describe, expect, it } from "vitest";
import { mergeBody } from "../services/eventLog/index.js";

const server = "top line\n\nbottom line"; // what the server holds
// nodeUpdate.ts: mergeBody(baseMarkdown, newBody, oldBody) unless the caller keeps the current side.
const save = (base: string, mine: string) => mergeBody(base, mine, server);

describe("a save whose base holds text the server never got", () => {
  it("drops that text, silently, when the new edit is elsewhere", () => {
    expect(save(`${server}\n\nstranded`, "top line edited\n\nbottom line\n\nstranded"))
      .toEqual(expect.objectContaining({ merged: "top line edited\n\nbottom line", conflicts: [] }));
    expect(save(`${server} stranded`, "top line edited\n\nbottom line stranded"))
      .toEqual(expect.objectContaining({ merged: "top line edited\n\nbottom line", conflicts: [] }));
  });

  it("keeps it, as a conflict, when the new edit is on the same line", () => {
    const result = save(`${server} stranded`, `${server} stranded more`);
    expect(result.merged).toBe(`${server} stranded more`);
    expect(result.conflicts).toHaveLength(1);
  });
});
