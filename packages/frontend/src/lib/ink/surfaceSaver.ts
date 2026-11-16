// The saving half of an ink surface — shared by every host that keeps a drawing in a note's attribute
// (the content tab's handwriting page and PDF in OverviewEditor, the 「手寫」 tab's pane, a whiteboard's pen layer in
// CanvasInkLayer): remember which drawing the next save is made from, and move that forward only as the server answers.
//
// A save names the drawing it was made from (its base): the server merges it into what another device stored meanwhile
// (@onden/markdown/ink mergeInk), and the app sends only what changed against that base (lib/data/patchedBody). So the
// base has to be a drawing the server holds, and the merge has to read "in the base, not in the save" only for what the
// person really removed:
//
//   • Normally the base is the text the server answered with for the last save it accepted. When that answer holds another
//     device's strokes the surface does not show, the save is first merged here the way the server would merge it (the
//     surface's last saved drawing is the merge base, the server's answer the other side), so it carries those strokes
//     and its patch is made against text the server has: a save never reads them as deleted, and never needs a second
//     request with the whole value.
//   • A save made while an earlier one is still unanswered is made from that earlier drawing (a stroke drawn then undone
//     before the answer must read as removed).
//   • If that earlier save is then refused (or its local copy failed), the later one was made from a drawing the server
//     never had: when it is accepted, the strokes only the refused one held read as deleted. The saver sends the
//     surface's drawing once more, now made from what the server does hold, so they come back (they are still on screen).

import { useCallback, useRef } from "react";
import { mergeInk } from "@onden/markdown/ink";
import { encodeInk } from "./store";
import { saveInk, type InkSaveBase, type InkSaveDoc, type InkSaveOptions } from "../data";

/** How a save ended: accepted or not, what the server stored, and the text that was sent as the value (null: only the offline queue holds it). */
type InkSaveOutcome = { saved: boolean; stored: string | null; sent: string | null };
type InkSend = (nodeId: string, doc: InkSaveBase, base: InkSaveBase | null | undefined, options?: InkSaveOptions) => Promise<InkSaveOutcome>;

const sendInk: InkSend = async (nodeId, doc, base, options) => {
  let answer: { stored: string; sent: string } | null = null;
  const saved = await saveInk(nodeId, doc, base, { ...options, onServerAnswer: (stored, sent) => { answer = { stored, sent }; } });
  return { saved: saved === true, stored: (answer as { stored: string } | null)?.stored ?? null, sent: (answer as { sent: string } | null)?.sent ?? null };
};

type Sent = {
  doc: InkSaveDoc;
  /** the unanswered save this one was made from; 0 = what the server holds */
  madeFrom: number;
  /** what went out is `doc` merged with the server's strokes, not `doc` itself */
  merged: boolean;
};
type NodeState = {
  /** What the server holds, as far as this saver knows: what the surface loaded, then the text of each accepted save's answer. */
  server: InkSaveBase | null | undefined;
  /** The surface's own drawing at the last save the server accepted (or when it loaded). It differs from `server` when the
   *  server's answer holds strokes the surface does not show: another device's, or ones a refused save never delivered. */
  own: InkSaveBase | null | undefined;
  /** Every save sent since the last quiet moment (none pending), by number. */
  sent: Map<number, Sent>;
  /** The newest of them: the drawing the surface shows. */
  latest: number;
  pending: Set<number>;
  refused: Set<number>;
  /** An accepted save was made from a refused one: the server may lack strokes the surface shows. */
  damaged: boolean;
};

export class InkSaver {
  private seq = 0;
  private readonly nodes = new Map<string, NodeState>();

  /** `attr` is the attribute the surface keeps its drawing in (default `ink_data`; `note_ink` for the 手寫 tab); `send` is
   *  injectable for tests. */
  constructor(private readonly attr?: InkSaveOptions["attr"], private readonly send: InkSend = sendInk) {}

  private state(nodeId: string): NodeState {
    let state = this.nodes.get(nodeId);
    if (!state) {
      // Nothing loaded for this note: a save has no base, and the server stores it as sent.
      state = { server: undefined, own: undefined, sent: new Map(), latest: 0, pending: new Set(), refused: new Set(), damaged: false };
      this.nodes.set(nodeId, state);
    }
    return state;
  }

  /** What a surface loaded (a note opened, a version restored): the base of its next save (null: the note had no drawing). */
  rebase(nodeId: string, doc: InkSaveBase | null): void {
    const state = this.state(nodeId);
    state.server = state.own = doc;
    // Saves answered from now on were made before this: they say nothing about what the surface holds.
    state.sent.clear();
    state.refused.clear();
    state.latest = 0;
    state.damaged = false;
  }

  save(nodeId: string, next: InkSaveDoc, options?: InkSaveOptions): void {
    const state = this.state(nodeId);
    // Unanswered saves: this one is made from the newest of them, else from what the server holds.
    const from = state.pending.size > 0 ? state.latest : 0;
    const seq = ++this.seq;
    state.pending.add(seq);
    const { value, base, merged } = from ? { value: next, base: state.sent.get(from)!.doc, merged: false } : this.fromServer(state, next);
    state.sent.set(seq, { doc: next, madeFrom: from, merged });
    state.latest = seq;
    const sent = this.send(nodeId, value, base, this.attr ? { ...options, attr: this.attr } : options);
    void Promise.resolve(sent).then((outcome) => this.answered(nodeId, state, seq, outcome));
  }

  /** The value and base of a save made from what the server holds: `next` as it is, or — when the server's text holds
   *  strokes the surface does not show — `next` merged with them, the way the server merges (the surface's own drawing is
   *  the merge base), so the save never reads them as deleted and its patch is made against text the server has. */
  private fromServer(state: NodeState, next: InkSaveDoc): { value: InkSaveBase; base: InkSaveBase | null | undefined; merged: boolean } {
    const { own, server } = state;
    if (own === server || typeof server !== "string") return { value: next, base: server, merged: false };
    const ownText = own === null || own === undefined ? "" : typeof own === "string" ? own : encodeInk(own);
    return ownText === server ? { value: next, base: server, merged: false } : { value: mergeInk(ownText, server, encodeInk(next)).value, base: server, merged: true };
  }

  private madeFromRefused(state: NodeState, seq: number): boolean {
    for (let from = state.sent.get(seq)?.madeFrom ?? 0; from !== 0; from = state.sent.get(from)?.madeFrom ?? 0) if (state.refused.has(from)) return true;
    return false;
  }

  private answered(nodeId: string, state: NodeState, seq: number, outcome: InkSaveOutcome): void {
    const mine = state.sent.get(seq);
    state.pending.delete(seq);
    if (!mine) return; // the surface was rebased meanwhile: what it loaded is the base now
    if (outcome.saved) {
      if (this.madeFromRefused(state, seq)) state.damaged = true;
      if (outcome.stored === null) {
        // Only the offline queue holds it: the next save is made from it as the surface's own drawing.
        state.server = state.own = mine.doc;
      } else {
        state.server = outcome.stored;
        // The surface's drawing at this save — unless the server's answer lacks strokes the surface still shows
        // (the save was made from a refused one): `own` stays where the server last agreed with it, and the save below
        // merges the surface's drawing into the server's text.
        if (!state.damaged) state.own = !mine.merged && outcome.sent === outcome.stored ? outcome.stored : mine.merged ? encodeInk(mine.doc) : outcome.sent ?? mine.doc;
      }
    } else state.refused.add(seq);
    if (state.pending.size > 0) return;
    const again = state.damaged ? state.sent.get(state.latest) : undefined;
    state.damaged = false;
    this.settle(state);
    // Made from what the server holds now (nothing is pending, so `server` is the base).
    if (again) this.save(nodeId, again.doc);
  }

  /** Nothing is pending: the numbers of the saves so far no longer matter. A save still pending keeps its record. */
  private settle(state: NodeState): void {
    if (state.pending.size > 0) return;
    state.sent.clear();
    state.refused.clear();
    state.latest = 0;
  }
}

/** The saver of one surface, kept for its lifetime. */
export function useInkSurfaceSaver(attr?: InkSaveOptions["attr"]) {
  const saver = useRef<InkSaver | null>(null);
  saver.current ??= new InkSaver(attr);
  const rebase = useCallback((nodeId: string, doc: InkSaveBase | null) => saver.current!.rebase(nodeId, doc), []);
  const save = useCallback((nodeId: string, next: InkSaveDoc, options?: InkSaveOptions) => saver.current!.save(nodeId, next, options), []);
  return { rebase, save };
}
