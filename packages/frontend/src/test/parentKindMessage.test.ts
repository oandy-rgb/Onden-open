import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { writeFailureMessage } from "../lib/data/writeErrors";
import { serverErrorMessage } from "../lib/serverErrors";
import { setLocalePref } from "../lib/i18n";

// The tag tree and the note tree are separate (backend services/parentKind.ts):
// a refused parent reads as a plain sentence, in zh-TW too.

const refusal = (detail: string) => new ApiError(409, JSON.stringify({ error: "parent_kind_mismatch", detail }));

afterEach(() => setLocalePref("system"));

describe("parent_kind_mismatch", () => {
  it("a write refusal says why, in English and zh-TW", () => {
    // English shows the server's own sentence, as a read does (serverErrorMessage).
    expect(writeFailureMessage(refusal("a note's parent cannot be a tag"))).toBe("a note's parent cannot be a tag");
    expect(writeFailureMessage(new ApiError(409, JSON.stringify({ error: "parent_kind_mismatch" })))).toBe(
      "A note can't go under a tag, and a tag only goes under another tag: tags and notes are kept in separate trees.");
    setLocalePref("zh-TW");
    expect(writeFailureMessage(refusal("a tag's parent must be a tag"))).toBe(
      "筆記不能放在標籤底下，標籤也只能放在另一個標籤底下：標籤和筆記是分開的兩棵樹。");
  });

  it("the server-error text for the code is the same sentence", () => {
    setLocalePref("zh-TW");
    expect(serverErrorMessage("parent_kind_mismatch", "a note's parent cannot be a tag")).toBe(
      "筆記不能放在標籤底下，標籤也只能放在另一個標籤底下：標籤和筆記是分開的兩棵樹。");
  });
});
