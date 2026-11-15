import { beforeEach, describe, expect, it } from "vitest";
import { bindAccountStorage } from "./accountStorage";
import { PREFS, getPref, setPref } from "./prefs";
import { REMEMBERED_NOTES, loadFoldMarks, saveFoldMarks } from "./editorFoldStore";

beforeEach(() => { localStorage.clear(); bindAccountStorage("unit-test-account", ""); });

describe("remembered folds", () => {
  it("round-trips a note's marks and forgets a note with none", () => {
    saveFoldMarks("n1", [{ text: "# A", nth: 0 }]);
    expect(loadFoldMarks("n1")).toEqual([{ text: "# A", nth: 0 }]);
    saveFoldMarks("n1", []);
    expect(loadFoldMarks("n1")).toEqual([]);
  });

  it("ignores stored junk instead of failing", () => {
    setPref(PREFS.editorFolds, "{not json");
    expect(loadFoldMarks("n1")).toEqual([]);
    setPref(PREFS.editorFolds, JSON.stringify({ n1: [{ text: 5 }, { text: "# ok", nth: 1 }, null], n2: "x" }));
    expect(loadFoldMarks("n1")).toEqual([{ text: "# ok", nth: 1 }]);
    expect(loadFoldMarks("n2")).toEqual([]);
  });

  it("keeps only the most recently folded notes", () => {
    for (let i = 0; i < REMEMBERED_NOTES + 5; i++) saveFoldMarks(`n${i}`, [{ text: "# A", nth: 0 }]);
    expect(loadFoldMarks("n0")).toEqual([]);
    expect(loadFoldMarks(`n${REMEMBERED_NOTES + 4}`)).toHaveLength(1);
  });

  it("does nothing without a note key, and never touches the note text store", () => {
    saveFoldMarks(undefined, [{ text: "# A", nth: 0 }]);
    expect(getPref(PREFS.editorFolds)).toBeNull();
  });
});
