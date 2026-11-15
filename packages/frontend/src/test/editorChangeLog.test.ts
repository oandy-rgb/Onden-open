import { describe, expect, it } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { recordEditorUpdate, resetEditorChanges, restoreEditorChanges, takeEditorChanges } from "../lib/editorChangeLog";

// A person's edit, as the editor reports one.
const recordEditorChange = (noteId: string, changes: Parameters<typeof recordEditorUpdate>[1], carried: { id: string; from: number; to: number }[] = []) =>
  recordEditorUpdate(noteId, changes, { external: false, carried });

const ins = (len: number, at: number, text: string) => ChangeSet.of({ from: at, insert: text }, len);

describe("editorChangeLog", () => {
  it("composes several edits into one set that fits the save's lengths", () => {
    resetEditorChanges("n");
    recordEditorChange("n", ins(5, 0, "ab"));
    recordEditorChange("n", ins(7, 7, "!"));
    const got = takeEditorChanges("n", 5, 8);
    expect(got).not.toBeNull();
    expect(ChangeSet.fromJSON(got!.body.changes).newLength).toBe(8);
    expect(takeEditorChanges("n", 5, 8)).toBeNull();
  });
  it("sends nothing when the lengths do not fit (the server derives the change)", () => {
    resetEditorChanges("m");
    recordEditorChange("m", ins(5, 0, "ab"));
    expect(takeEditorChanges("m", 9, 11)).toBeNull();
  });
  it("a failed save gives the edits back so later ones continue from them", () => {
    resetEditorChanges("k");
    recordEditorChange("k", ins(3, 0, "x"));
    const first = takeEditorChanges("k", 3, 4)!;
    recordEditorChange("k", ins(4, 4, "y"));
    restoreEditorChanges("k", first.taken);
    expect(takeEditorChanges("k", 3, 5)).not.toBeNull();
  });
});
