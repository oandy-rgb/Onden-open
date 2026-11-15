import { beforeEach, describe, expect, it } from "vitest";
import { barSummary, decisionNotice, layoutSuggestions, placesInOrder, type SuggestionsView } from "./aiSuggestions";
import type { NoteSuggestion, SuggestionItem } from "@onden/contract";
import { setLocalePref } from "./i18n";

const doc = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";
const item = (id: string, kind: SuggestionItem["kind"], base_text: string, new_text: string | null, extra: Partial<SuggestionItem> = {}): SuggestionItem =>
  ({ id, seq: 0, kind, base_text, base_occurrence: 0, new_text, status: "pending", ...extra });
const view = (items: SuggestionItem[], can_decide = true, extra: Partial<NoteSuggestion> = {}): SuggestionsView => ({
  can_decide,
  suggestions: [{ id: "s1", agent_actor_id: "a1", agent_name: "我的 Claude", session_id: null, created_at: "2026-10-30T00:00:00Z", older: false, skill: null, items, ...extra }],
});
const base = { canEdit: true, online: true, busy: new Set<string>() };

beforeEach(() => setLocalePref("en"));

describe("where each suggestion sits in the text now", () => {
  const markdown = doc("# Title", "alpha", "beta");

  it("says so when a place changes only the spacing (the words are the same), instead of showing 'X → X'", () => {
    const layout = layoutSuggestions(view([item("i1", "replace", "alpha", "alpha", { change: "spacing" }), item("i2", "replace", "beta", "BETA")]), { ...base, markdown });
    expect(layout.places.map((p) => p.spacingOnly)).toEqual([true, false]);
  });

  it("finds a place where the server says it is now, not by the text the AI read (an accepted place rewrote the anchor)", () => {
    const text = doc("# Title", "ALPHA", "beta");
    const layout = layoutSuggestions(view([item("i1", "insert", "alpha", "gamma", { place: { text: "ALPHA", occurrence: 0 } })]), { ...base, markdown: text });
    expect(layout.off).toEqual([]);
    expect(layout.places[0]).toMatchObject({ kind: "insert", at: text.indexOf("ALPHA") + 5 });
    // …and one the server cannot find is listed as changed, never drawn at a guess
    const lost = layoutSuggestions(view([item("i2", "replace", "alpha", "x", { place: null })]), { ...base, markdown: text });
    expect(lost.places).toEqual([]);
    expect(lost.off[0]).toMatchObject({ state: "changed" });
  });

  it("draws a replace on the paragraph it is about, an insert after its anchor, a comment after its quote", () => {
    const layout = layoutSuggestions(view([
      item("i1", "replace", "alpha", "ALPHA"), item("i2", "insert", "beta", "gamma"), item("i3", "comment", "# Title", "is this the right name?"),
    ]), { ...base, markdown });
    const [replace, insert, comment] = layout.places;
    expect(markdown.slice(replace!.from, replace!.to)).toBe("alpha");
    expect(replace).toMatchObject({ kind: "replace", newText: "ALPHA", at: replace!.to, canAct: true, agentName: "我的 Claude" });
    expect(insert).toMatchObject({ kind: "insert", from: markdown.indexOf("beta") + 4, at: markdown.indexOf("beta") + 4 });
    expect(comment).toMatchObject({ kind: "comment", at: "# Title".length });
    expect(layout).toMatchObject({ total: 3, actionable: 3, off: [] });
    expect(placesInOrder(layout.places).map((p) => p.itemId)).toEqual(["i3", "i1", "i2"]);
  });

  it("an insert at the very start and a comment about the whole note have no paragraph", () => {
    const layout = layoutSuggestions(view([item("i1", "insert", "", "first"), item("i2", "comment", "", "overall")]), { ...base, markdown });
    expect(layout.places).toEqual([expect.objectContaining({ kind: "insert", at: 0, to: 0 })]);
    expect(layout.off).toEqual([expect.objectContaining({ kind: "comment", text: "overall", state: "open" })]);
  });

  it("the title is listed in the bar, not in the text", () => {
    const layout = layoutSuggestions(view([item("t", "title", "Old", "New")]), { ...base, markdown });
    expect(layout.places).toEqual([]);
    expect(layout.off).toEqual([expect.objectContaining({ kind: "title", text: "New", state: "open" })]);
    expect(layout.actionable).toBe(1);
  });

  it("a paragraph the person has edited since is 'changed': told so, dismiss only, not counted as acceptable", () => {
    const layout = layoutSuggestions(view([item("i1", "replace", "alpha", "ALPHA"), item("i2", "delete", "beta", null)]), { ...base, markdown: doc("# Title", "alpha, my words", "beta") });
    expect(layout.places.map((p) => p.itemId)).toEqual(["i2"]);
    expect(layout.off).toEqual([expect.objectContaining({ itemId: "i1", state: "changed" })]);
    expect(layout).toMatchObject({ total: 2, actionable: 1 });
  });

  it("a place the server found stale is changed too", () => {
    const layout = layoutSuggestions(view([item("i1", "replace", "alpha", "ALPHA", { status: "stale" })]), { ...base, markdown });
    expect(layout.off).toEqual([expect.objectContaining({ state: "changed" })]);
    expect(layout.places).toEqual([]);
  });

  it("tells the second identical paragraph from the first", () => {
    const twin = doc("same", "mid", "same");
    const second = layoutSuggestions(view([item("i1", "replace", "same", "changed", { base_occurrence: 1 })]), { ...base, markdown: twin });
    expect(second.places[0]!.from).toBe(twin.lastIndexOf("same"));
  });

  it("the buttons wait when the person only reads, is offline, or the decision is being sent", () => {
    const v = view([item("i1", "replace", "alpha", "ALPHA")]);
    expect(layoutSuggestions(v, { ...base, markdown, canEdit: false }).places[0]!.canAct).toBe(false);
    expect(layoutSuggestions({ ...v, can_decide: false }, { ...base, markdown }).places[0]!.canAct).toBe(false);
    expect(layoutSuggestions(v, { ...base, markdown, online: false }).places[0]!.canAct).toBe(false);
    expect(layoutSuggestions(v, { ...base, markdown, busy: new Set(["i1"]) }).places[0]).toMatchObject({ busy: true });
  });

  it("an older suggestion is labelled, never dropped", () => {
    const layout = layoutSuggestions(view([item("i1", "replace", "alpha", "ALPHA")], true, { older: true }), { ...base, markdown });
    expect(layout.places[0]!.older).toBe(true);
  });

  it("collects the skill behind the listed suggestions once, none for an empty set", () => {
    const skill = { name: "出考題", picked: true, reason: "準備期中" };
    const two = { ...view([item("i1", "comment", "", "a")], true, { skill }), };
    two.suggestions.push({ ...two.suggestions[0]!, id: "s2", items: [item("i2", "comment", "", "b")] });
    two.suggestions.push({ ...two.suggestions[0]!, id: "s3", skill: { name: "不顯示", picked: false, reason: null }, items: [] });
    expect(layoutSuggestions(two, { ...base, markdown }).skills).toEqual([skill]);
  });

  it("no suggestions, nothing to draw", () => {
    expect(layoutSuggestions(null, { ...base, markdown })).toEqual({ places: [], off: [], total: 0, actionable: 0, skills: [] });
  });
});

describe("words", () => {
  it("counts in the person's language, singular and plural", () => {
    expect(barSummary({ places: [], off: [], total: 1, actionable: 1, skills: [] })).toBe("1 AI suggestion in this note");
    expect(barSummary({ places: [], off: [], total: 3, actionable: 3, skills: [] })).toBe("3 AI suggestions in this note");
    setLocalePref("zh-TW");
    expect(barSummary({ places: [], off: [], total: 3, actionable: 3, skills: [] })).toBe("這篇有 3 處 AI 建議");
  });

  it("says when places were not applied, and nothing when all were", () => {
    expect(decisionNotice({ accepted: ["a"], stale: [] })).toBeNull();
    expect(decisionNotice({ stale: ["a"] })).toBe("1 place had changed since the AI wrote it, so it wasn't applied.");
    expect(decisionNotice({ stale: ["a", "b"] })).toBe("2 places had changed since the AI wrote them, so they weren't applied.");
    expect(decisionNotice({ void: ["a"] })).toContain("moved");
  });
});
