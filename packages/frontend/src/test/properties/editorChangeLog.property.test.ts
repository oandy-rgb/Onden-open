// Random sessions against the editor's change log (lib/editorChangeLog.ts): typing, text replaced from outside
// (another note opened, a remote edit), switching between notes, saves. The model keeps what the server holds per
// note. Invariants (scan 01 #3):
//   • no exception: whatever the order of notes opened and left, the log never composes mismatched lengths
//   • exact or nothing: a taken change set, applied to the text the server holds, gives exactly the draft
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/editorChangeLog

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ChangeSet, EditorState } from "@codemirror/state";
import { recordEditorUpdate, resetEditorChanges, takeEditorChanges } from "../../lib/editorChangeLog";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const params = { numRuns: PROPS_RUNS, seed: PROPS_SEED };
const NOTES = ["a", "b", "c"];

type Step =
  | { kind: "type"; at: number; text: string; del: number }
  | { kind: "switch"; to: number }
  | { kind: "remote"; text: string }
  | { kind: "save" };
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("type" as const), at: fc.nat(40), text: fc.string({ maxLength: 4 }), del: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("switch" as const), to: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("remote" as const), text: fc.string({ maxLength: 12 }) }) },
  { weight: 2, arbitrary: fc.constant({ kind: "save" as const }) },
);
const bodies = fc.tuple(...NOTES.map(() => fc.string({ maxLength: 20 })));

/** The editor of MarkdownEditor: one state that is swapped to the other note's text, as the component does. */
function session(initial: string[], steps: Step[]): void {
  const server = new Map(NOTES.map((n, i) => [n, initial[i]]));
  let shown = 0;
  let state = EditorState.create({ doc: "" });
  const replaceAll = (text: string) => {
    const tr = state.update({ changes: { from: 0, to: state.doc.length, insert: text } });
    state = tr.state;
    recordEditorUpdate(NOTES[shown], tr.changes, { external: true });
  };
  // Mount: the editor starts empty and the note's text is put in from outside.
  resetEditorChanges(NOTES[shown]);
  replaceAll(server.get(NOTES[shown])!);
  for (const s of steps) {
    if (s.kind === "type") {
      const at = s.at % (state.doc.length + 1);
      const tr = state.update({ changes: { from: at, to: Math.min(state.doc.length, at + s.del), insert: s.text } });
      state = tr.state;
      recordEditorUpdate(NOTES[shown], tr.changes, { external: false });
    } else if (s.kind === "switch") {
      shown = s.to;
      replaceAll(server.get(NOTES[shown])!);
    } else if (s.kind === "remote") {
      server.set(NOTES[shown], s.text);
      replaceAll(s.text);
    } else {
      const base = server.get(NOTES[shown])!;
      const draft = state.doc.toString();
      const got = takeEditorChanges(NOTES[shown], base.length, draft.length);
      if (got) {
        const applied = ChangeSet.fromJSON(got.body.changes).apply(state.update({ changes: { from: 0, to: state.doc.length, insert: base } }).state.doc);
        expect(applied.toString()).toBe(draft);
      }
      server.set(NOTES[shown], draft);
    }
  }
}

describe("editorChangeLog sessions (scan 01 #3)", () => {
  it("random typing, remote edits, note switches and saves: no exception, and a taken change set always turns the saved text into the draft", () => {
    fc.assert(fc.property(bodies, fc.array(step, { maxLength: 30 }), (initial, steps) => session(initial, steps)), params);
  });

  it("open A, move to B without editing, move to C, back to B: logging the edit does not throw", () => {
    session(["aaaaa", "bb", "c"], [{ kind: "switch", to: 1 }, { kind: "switch", to: 2 }, { kind: "switch", to: 1 }, { kind: "type", at: 1, text: "x", del: 0 }, { kind: "save" }]);
  });

  it("the first save after opening a note and typing carries its exact change set", () => {
    const body = "hello world";
    resetEditorChanges("a");
    let state = EditorState.create({ doc: "" });
    const open = state.update({ changes: { from: 0, insert: body } });
    state = open.state;
    recordEditorUpdate("a", open.changes, { external: true });
    const typed = state.update({ changes: { from: 5, insert: "!" } });
    recordEditorUpdate("a", typed.changes, { external: false });
    expect(takeEditorChanges("a", body.length, body.length + 1)).not.toBeNull();
  });
});
