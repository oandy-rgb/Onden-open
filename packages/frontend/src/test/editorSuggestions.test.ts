// An AI's pending places in the editor (lib/editorSuggestions): the paragraph it
// would replace is struck through, what it would put there is shown with Accept
// and Reject, the buttons call the host, and a typed edit moves the place with
// its text (the note itself is never changed by drawing).
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setSuggestionPlaces, suggestionPlacesExtension } from "../lib/editorSuggestions";
import type { Place } from "../lib/aiSuggestions";

const place = (extra: Partial<Place> = {}): Place => ({
  itemId: "i1", suggestionId: "s1", kind: "replace", from: 0, to: 5, at: 5, newText: "ALPHA", agentName: "我的 Claude",
  spacingOnly: false, older: false, busy: false, canAct: true, ...extra,
});

function mount(doc: string, onDecide = vi.fn()) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [suggestionPlacesExtension({ onDecide })] }), parent });
  return { view, onDecide, parent };
}

describe("suggestion places", () => {
  it("strikes the replaced paragraph, shows the new text with a ＋ and the two buttons", () => {
    const { view, parent } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place()]) });
    expect(parent.querySelector(".cm-ai-del")?.textContent).toBe("alpha");
    expect(parent.querySelector(".cm-ai-add .cm-ai-text")?.textContent).toBe("ALPHA");
    expect(parent.querySelector(".cm-ai-sign")?.textContent).toBe("＋");
    expect([...parent.querySelectorAll(".cm-ai-btn")].map((b) => b.textContent)).toEqual(["Accept", "Reject"]);
    expect(view.state.doc.toString()).toBe("alpha\n\nbeta\n");
  });

  it("a place that only changes spacing is not struck through and says so, instead of showing the same words twice", () => {
    const { view, parent } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place({ newText: "alpha", spacingOnly: true })]) });
    expect(parent.querySelector(".cm-ai-del")).toBeNull();
    expect(parent.querySelector(".cm-ai-add")).toBeNull();
    expect(parent.querySelector(".cm-ai-hint")?.textContent).toBe("Only the spacing around this paragraph changes");
    expect([...parent.querySelectorAll(".cm-ai-btn")].map((b) => b.textContent)).toEqual(["Accept", "Reject"]);
  });

  it("a button hands its place and decision to the host", () => {
    const { view, parent, onDecide } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place()]) });
    (parent.querySelector(".cm-ai-btn--reject") as HTMLButtonElement).click();
    (parent.querySelector(".cm-ai-btn--accept") as HTMLButtonElement).click();
    expect(onDecide.mock.calls.map(([p, d]) => [p.itemId, d])).toEqual([["i1", "reject"], ["i1", "accept"]]);
  });

  it("the buttons are disabled when the person cannot decide or the decision is being sent", () => {
    const { view, parent } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place({ canAct: false })]) });
    expect([...parent.querySelectorAll<HTMLButtonElement>(".cm-ai-btn")].every((b) => b.disabled)).toBe(true);
    view.dispatch({ effects: setSuggestionPlaces.of([place({ busy: true })]) });
    expect(parent.querySelector(".cm-ai-btn")?.getAttribute("aria-busy")).toBe("true");
  });

  it("a delete says so without new text; a comment can be marked read", () => {
    const { view, parent } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place({ kind: "delete", newText: null }), place({ itemId: "i2", kind: "comment", newText: "check this", from: 12, to: 12, at: 11 })]) });
    expect(parent.querySelector(".cm-ai-hint")?.textContent).toBe("Suggests removing this paragraph");
    expect(parent.querySelector(".cm-ai-comment-text")?.textContent).toBe("check this");
    expect([...parent.querySelectorAll(".cm-ai-place--comment .cm-ai-btn")].map((b) => b.textContent)).toEqual(["Mark as read", "Ignore"]);
  });

  it("a place past the end of the text stays inside it, and a typed edit moves the place with its text", () => {
    const { view, parent } = mount("alpha");
    expect(() => view.dispatch({ effects: setSuggestionPlaces.of([place({ from: 0, to: 99, at: 99 })]) })).not.toThrow();
    view.dispatch({ changes: { from: 0, insert: "intro\n\n" } });
    expect(view.state.doc.toString()).toBe("intro\n\nalpha");
    view.dispatch({ effects: setSuggestionPlaces.of([place({ from: 7, to: 12, at: 12 })]) });
    view.dispatch({ changes: { from: 9, insert: "X" } });
    expect(parent.querySelector(".cm-ai-del")?.textContent).toBe("alXpha");
    view.dispatch({ changes: { from: 0, insert: "more " } });
    expect(parent.querySelector(".cm-ai-del")?.textContent).toBe("alXpha");
  });
});

describe("a place that only changes indentation", () => {
  it("says so instead of showing the same words twice", () => {
    const { view, parent } = mount("alpha\n\nbeta\n");
    view.dispatch({ effects: setSuggestionPlaces.of([place({ newText: "alpha", indentOnly: true })]) });
    expect(parent.querySelector(".cm-ai-add")).toBeNull();
    expect(parent.querySelector(".cm-ai-hint")?.textContent).toBe("Only the indentation or line ends of this paragraph change");
  });
});
