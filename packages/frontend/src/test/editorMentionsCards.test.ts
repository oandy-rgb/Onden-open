// Cards under @mentions (lib/editorMentions): a card placed past the end of the
// editor's text — the host already counts the mention's new ^id the editor has
// not received yet — must not break the next edit.
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { mentionCardsExtension, setMentionCards } from "../lib/editorMentions";

describe("mention cards", () => {
  it("a card past the end of the text stays inside it, and the next edit maps it", () => {
    let state = EditorState.create({ doc: "@ai 幫我整理成三點", extensions: [mentionCardsExtension({ onAction: () => {} })] });
    const card = { key: "k1", at: 33 } as unknown as Parameters<typeof setMentionCards.of>[0][number];
    state = state.update({ effects: setMentionCards.of([card]) }).state;
    expect(() => { state = state.update({ changes: { from: state.doc.length, insert: " ^abcd" } }).state; }).not.toThrow();
    expect(state.doc.toString()).toBe("@ai 幫我整理成三點 ^abcd");
  });
});
