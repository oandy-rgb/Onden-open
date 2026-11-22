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
//     request with the whole value. When that merge would drop something the save holds (both changed the same item and
//     the other side sorts later), the save is sent as it is with the surface's last saved drawing as its base instead,
//     and the server's merge keeps the dropped version with its conflict record.
//   • A save made while an earlier one is still unanswered is made from that earlier drawing (a stroke drawn then undone
//     before the answer must read as removed).
//   • If that earlier save is then refused (or its local copy failed), the later one was made from a drawing the server
//     never had: when it is accepted, the strokes only the refused one held read as deleted. The saver sends the
//     surface's drawing once more, now made from what the server does hold, so they come back (they are still on screen).
//   • From the first refused save on, what each save changed (draw, erase, undo of an erase, removal) is kept as a change
//     from the drawing it was made from to the drawing it held. A save made from what the server holds applies those
//     changes again, in order, over the server's text, each against its own base: a change the server never saw reads as the
//     person's, and one it did see and the person has since taken back (an undo of an erase) reads as taken back, not as the
//     other side's.
//     Refused changes that follow each other are one change, so a long run of refusals keeps the list short. Before the surface
//     has a text from the server (it just loaded, or only the offline queue holds the drawing) nothing is applied again.

import { useCallback, useRef } from "react";
import { mergeInk, encodeInk } from "@onden/markdown/ink";
import { mergeDropsSent, saveInk, type InkSaveBase, type InkSaveDoc, type InkSaveOptions } from "../data";

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
  /** the `unsent` changes this save applied again (made from what the server holds only) */
  replayed: Change[];
};
/** What a save changed: the drawing it was made from and the drawing it held, as text. */
/** `applied`: the server accepted the save. A change is a new object whenever it grows (never edited in place), so a save that
 *  applied it again removes exactly what it applied. */
type Change = { from: string; to: string; applied: boolean };
type NodeState = {
  /** What the server holds, as far as this saver knows: what the surface loaded, then the text of each accepted save's answer. */
  server: InkSaveBase | null | undefined;
  /** The surface's own drawing at the last save the server accepted (or when it loaded). It differs from `server` when the
   *  server's answer holds strokes the surface does not show: another device's, or ones a refused save never delivered. */
  own: InkSaveBase | null | undefined;
  /** What saves changed since the first refused one, oldest first (accepted ones too: an accepted undo of a refused draw has to
   *  be applied after it). Refused changes that follow each other are joined into one.
   *  Dropped when a save that applied them again is accepted,
   *  or when the surface loads a drawing. */
  unsent: Change[];
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
      state = { server: undefined, own: undefined, unsent: [], sent: new Map(), latest: 0, pending: new Set(), refused: new Set(), damaged: false };
      this.nodes.set(nodeId, state);
    }
    return state;
  }

  /** What a surface loaded (a note opened, a version restored): the base of its next save (null: the note had no drawing). */
  rebase(nodeId: string, doc: InkSaveBase | null): void {
    const state = this.state(nodeId);
    state.server = state.own = doc;
    state.unsent = [];
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
    const { value, base, merged, replayed } = from ? { value: next, base: state.sent.get(from)!.doc, merged: false, replayed: [] } : this.fromServer(state, next);
    state.sent.set(seq, { doc: next, madeFrom: from, merged, replayed });
    state.latest = seq;
    const sent = this.send(nodeId, value, base, this.attr ? { ...options, attr: this.attr } : options);
    void Promise.resolve(sent).then((outcome) => this.answered(nodeId, state, seq, outcome));
  }

  /** The value and base of a save made from what the server holds: `next` as it is, or — when the server's text holds
   *  strokes the surface does not show, or refused saves changed something the server lacks — `next` merged into the server's
   *  text the way the server merges, so the save never reads those strokes as deleted and its patch is made against text the
   *  server has. */
  private fromServer(state: NodeState, next: InkSaveDoc): { value: InkSaveBase; base: InkSaveBase | null | undefined; merged: boolean; replayed: Change[] } {
    const { own, server, unsent } = state;
    if (typeof server !== "string") return { value: next, base: server, merged: false, replayed: [] };
    const nextText = encodeInk(next);
    if (unsent.length > 0) {
      // Each step checked (PR #1783 round 4): a step that leaves out this surface's version of something another device
      // changed too means that version would exist nowhere — so the surface's drawing goes instead, with the base the
      // chain started from, and the server merges it and keeps it with the conflict record (`submitted_value_ref`).
      let value = server, lost = false;
      for (const change of unsent) {
        const step = mergeInk(change.from, value, change.to);
        lost ||= mergeDropsSent(step, change.to);
        value = step.value;
      }
      const last = unsent[unsent.length - 1]!.to;
      if (last !== nextText) {
        const step = mergeInk(last, value, nextText);
        lost ||= mergeDropsSent(step, nextText);
        value = step.value;
      }
      if (lost) return { value: next, base: unsent[0]!.from, merged: false, replayed: [...unsent] };
      return { value, base: server, merged: true, replayed: [...unsent] };
    }
    if (own === server) return { value: next, base: server, merged: false, replayed: [] };
    const ownText = inkText(own);
    if (ownText === server) return { value: next, base: server, merged: false, replayed: [] };
    const merge = mergeInk(ownText, server, nextText);
    // The merge dropped something this save holds (the other side's version of an item both changed sorts later): that
    // version exists nowhere else, so it is not sent as a merge nobody sees. The original goes with its true base and the
    // server merges it the same way and keeps it with the conflict record (attributeWrites `submitted_value_ref`).
    // `own ?? null`: a surface that loaded nothing still sends a base ("" = none), so the server merges instead of overwriting.
    if (mergeDropsSent(merge, nextText)) return { value: next, base: own ?? null, merged: false, replayed: [] };
    return { value: merge.value, base: server, merged: true, replayed: [] };
  }

  /** A save's change, from the drawing it was made from (the one before it, else the last change's, else the surface's own). */
  private keepChange(state: NodeState, mine: Sent, applied: boolean): void {
    const last = state.unsent[state.unsent.length - 1];
    const from = mine.madeFrom !== 0 ? inkText(state.sent.get(mine.madeFrom)?.doc) : last ? last.to : inkText(state.own);
    const to = encodeInk(mine.doc);
    if (from === to) return;
    // Two changes the server never took, one after the other, are one change: keeps the list short while saves go on being
    // refused. A taken change is never joined with a refused one (an erase taken, its undo refused: two steps).
    if (last && !last.applied && !applied && last.to === from) {
      state.unsent.pop();
      if (last.from !== to) state.unsent.push({ from: last.from, to, applied });
    } else state.unsent.push({ from, to, applied });
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
      if (mine.replayed.length > 0) state.unsent = state.unsent.filter((change) => !mine.replayed.includes(change));
      else if (mine.madeFrom === 0) state.unsent = []; // sent whole (the server had no text to merge into yet): nothing is left to send again
      else if (state.unsent.length > 0) this.keepChange(state, mine, true);
      if (outcome.stored === null) {
        // Only the offline queue holds it: the next save is made from it as the surface's own drawing.
        state.server = state.own = mine.doc;
        state.unsent = [];
      } else {
        state.server = outcome.stored;
        // The surface's drawing at this save — unless the server's answer lacks strokes the surface still shows
        // (the save was made from a refused one): `own` stays where the server last agreed with it, and the save below
        // merges the surface's drawing into the server's text.
        if (!state.damaged) state.own = !mine.merged && outcome.sent === outcome.stored ? outcome.stored : mine.merged ? encodeInk(mine.doc) : outcome.sent ?? mine.doc;
      }
    } else {
      state.refused.add(seq);
      this.keepChange(state, mine, false);
    }
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

const inkText = (doc: InkSaveBase | null | undefined): string => (doc === null || doc === undefined ? "" : typeof doc === "string" ? doc : encodeInk(doc));

/** The saver of one surface, kept for its lifetime. */
export function useInkSurfaceSaver(attr?: InkSaveOptions["attr"]) {
  const saver = useRef<InkSaver | null>(null);
  saver.current ??= new InkSaver(attr);
  const rebase = useCallback((nodeId: string, doc: InkSaveBase | null) => saver.current!.rebase(nodeId, doc), []);
  const save = useCallback((nodeId: string, next: InkSaveDoc, options?: InkSaveOptions) => saver.current!.save(nodeId, next, options), []);
  return { rebase, save };
}
