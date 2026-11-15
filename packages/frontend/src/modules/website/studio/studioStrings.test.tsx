import "../../../test/puckEnv";
// The website studio's own wording follows the interface language: nothing the studio says is
// fixed Chinese (a note's or space's own name is the person's, so it may be).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDesignV2, type PuckComponentData } from "@onden/site";
import { setLocalePref } from "../../../lib/i18n";
import { blockRows } from "../phone/phoneHome";
import { filterGroups, type BlockGroup } from "./blockKinds";
import { computeSuggestions } from "./suggestions";

const CJK = /[一-鿿]/;
const noteBlock = (noteId: string): PuckComponentData => ({ type: "note", props: { id: "n", noteId, blockId: "", display: "full" } });
const home = (...content: PuckComponentData[]) => ({ root: { props: {} }, content });

beforeEach(() => setLocalePref("en"));
afterEach(() => setLocalePref("zh-TW"));

describe("block search", () => {
  it("looks for the typed words together, not their letters scattered through a long description", () => {
    const kind = (id: string, label: string, description: string) => ({ id, type: id, label, description, icon: null });
    const scattered = "make every event task item new goal"; // m-e-e-t-i-n-g in order
    const groups = [{ tab: "parts", title: "T", hint: "", kinds: [kind("a", "Cards", scattered), kind("b", "Meeting", "")] }] as unknown as BlockGroup[];
    expect(filterGroups(groups, "meeting")[0]!.kinds.map((k) => k.id)).toEqual(["b"]);
  });
});

describe("studio wording in English", () => {
  it("suggestions are English, and Chinese in zh-TW", () => {
    const design = { ...defaultDesignV2({}), home: home({ type: "stack", props: { id: "s", bg: "none", heading: "auto", cls: "", css: "", items: [noteBlock("draft")] } }) };
    const notes = [{ id: "draft", title: "Draft", slug: "d", updatedAt: "", published: false }];
    const list = computeSuggestions({ design, notes, blocked: [], rowCounts: {} });
    expect(list[0]!.text).toBe("“Draft” is not published yet, so this spot on the site will be empty.");
    expect(CJK.test(list[0]!.applyLabel ?? "")).toBe(false);
    setLocalePref("zh-TW");
    expect(computeSuggestions({ design, notes, blocked: [], rowCounts: {} })[0]!.text).toBe("「Draft」還沒發布，網站上這一格會空著。");
  });

  it("the phone's rows say what is missing in English", () => {
    const names = { noteTitle: () => null, notePublished: () => false, tagName: () => null };
    const rows = blockRows(home(noteBlock("")), names);
    expect(rows[0]!.title).toBe("No note chosen yet");
    expect(blockRows(home(noteBlock("x")), { ...names, noteTitle: () => "Hi" })[0]!.title).toBe("Hi (not published)");
    const tagView: PuckComponentData = { type: "tag_view", props: { id: "v", tagId: "t", viewId: "", viewKind: "list", limit: 6, sort: "new" } };
    expect(blockRows(home(tagView), names)[0]!.title).toBe("Tag view: Untitled");
    expect(CJK.test(rows[0]!.title)).toBe(false);
  });
});
