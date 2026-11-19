// Owner report 2026-11-19 (Android, Brave PWA, Gboard Zhuyin): while typing, the characters just typed went away,
// came back by themselves, and the caret ended up BEFORE them (`以日曆為軸來串起|歷史`).
//
// This drives the REAL editor (MarkdownEditor, CodeMirror) bound to the REAL draft machinery (draftActions), the
// real note writer, write queue and store, the way OverviewEditorHost and useOverviewMode wire them. The server, the
// transport and the local database are the save-timing world (helpers/saveWorld.ts): every request waits until the
// test delivers it. A sync answer is captured when it is asked and delivered later, through the same road as
// syncEngine.applyAndShow (queued writes laid over it, then storeOps.applySyncDelta).
//
// Property (only this device writes): after every step the editor's document is exactly what the person typed, in
// order, and the caret is where their last keystroke left it. Fresh seed every run, printed; PROPS_SEED replays.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { act, render } from "@testing-library/react";
import { useEffect, useSyncExternalStore } from "react";
import { EditorView } from "@codemirror/view";

vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: vi.fn(async (path: string, init?: unknown) => {
    const { world } = await import("./helpers/saveWorld");
    return world.transport(path, init as never);
  }),
}));
vi.mock("../lib/localDb", async () => {
  const { world } = await import("./helpers/saveWorld");
  return { ...world.localDb };
});

import MarkdownEditor from "../components/MarkdownEditor";
import { ApiError, nodeNeedsBody, type ContentNode } from "../lib/api";
import { ownerData } from "./ownerData";
import { getAppState, getNode, resetAppState, selectOverviewSelectedNode, setData, subscribeApp } from "../lib/appStore";
import {
  __resetDraftStateForTests, applyRemoteNode, resetDraftForNode, setEditorComposing, typeIntoDraft,
} from "../lib/data/draftActions";
import { applySyncDelta } from "../lib/data/storeOps";
import { projectPendingNoteText } from "../lib/pendingNoteProjection";
import type { AppliedSyncDelta } from "../lib/localDb";
import { stopWriteRetry } from "../lib/data/writeQueue";
import { refreshRecoveryWrites } from "../lib/data/writeRecovery";
import { setPending } from "../lib/data/syncStatus";
import { bindAccountStorage } from "../lib/accountStorage";
import { world } from "./helpers/saveWorld";
import { dataSync } from "../lib/data";

bindAccountStorage("u", "");
world.makeApiError = (status) => new ApiError(status, JSON.stringify({ error: "x" }));

const RUNS = Number(process.env.PROPS_RUNS ?? 40);
const SEED = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) : Math.floor(Math.random() * 2 ** 31);
console.log(`[props] typedTextNeverReplacedByOlder seed=${SEED} runs=${RUNS} (replay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS})`);

const START = "以日曆為軸來串起";

/** OverviewEditorHost + useOverviewMode, reduced to what touches the text: the draft is the editor's value, typing
 *  goes to typeIntoDraft, a composition to setEditorComposing, and the two effects seed the draft and offer a
 *  changed row to applyRemoteNode. */
function Host() {
  const state = useSyncExternalStore(subscribeApp, getAppState);
  const node = selectOverviewSelectedNode(state);
  const needsBody = nodeNeedsBody(node);
  useEffect(() => { resetDraftForNode(needsBody ? null : node); }, [node?.id, needsBody]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { applyRemoteNode(node); }, [node?.id, node?.markdown, node?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  // OverviewEditorHost: while the note's text is still on the server, a loading pane, not the editor.
  if (!node || needsBody) return <div className="lazy-loading-pane" />;
  return (
    <MarkdownEditor nodeKey={node?.id} value={state.overviewDraft} nodes={[]} onMediaInsert={async () => null}
      onChange={(markdown) => { if (node) typeIntoDraft(node.id, { markdown }); }}
      onComposingChange={(on) => { if (node) setEditorComposing(node.id, on); }} />
  );
}

/** Let promise chains and React effects finish (the writer's answer handling, then the effects it causes). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { for (let j = 0; j < 60; j++) await Promise.resolve(); });
}

class Phone {
  private container!: HTMLElement;
  /** The editor, once the note's text is shown (null while the loading pane is up). */
  get view(): EditorView { return EditorView.findFromDOM(this.container.querySelector(".cm-editor") as HTMLElement)!; }
  get editorShown(): boolean { return this.container.querySelector(".cm-editor") !== null; }
  private placed = false;
  unmount = () => {};
  /** What the person typed, in order, and where their caret is. */
  typed = START;
  caret = START.length;
  private answers: ContentNode[][] = [];
  private chars = [..."歷史記錄筆記日曆時間軸串起來"];

  /** `slim`: the note's text is still on the server when it opens (a slim start, or a note made elsewhere): the
   *  editor appears once hydrateNode's read is answered (`bodyArrives`). */
  async open(options: { slim?: boolean } = {}): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stopWriteRetry();
    __resetDraftStateForTests();
    world.reset();
    world.server.get("a")!.markdown = START;
    localStorage.clear();
    await refreshRecoveryWrites();
    setPending(0);
    this.typed = START; this.caret = START.length; this.answers = []; this.placed = false;
    const rows = world.rows().map((n) => options.slim && n.id === "a" ? { ...n, markdown: "", body_len: START.length } : n);
    resetAppState({ data: { ...ownerData, bodies: options.slim ? "none" : "full", nodes: rows }, online: true, selectedId: "a" });
    const utils = render(<Host />);
    this.unmount = utils.unmount;
    this.container = utils.container;
    if (options.slim) void dataSync.hydrateNode("a");
    await settle();
    this.placeCaret();
  }

  /** The person taps the editor and goes to the end, once it is there (the e2e: click, End). */
  private placeCaret(): void {
    if (this.placed || !this.editorShown) return;
    this.placed = true;
    act(() => { this.view.dispatch({ selection: { anchor: this.caret } }); });
  }

  /** The read of the note's text (hydrateNode) is answered: the oldest, or another one waiting. */
  async bodyArrives(index: number): Promise<void> {
    world.answerRead(index);
    await settle();
    this.placeCaret();
  }

  /** The note is read again while it is open (syncEngine.releaseHeldNotes, a note held behind the queue). */
  readAgain(): void { void dataSync.hydrateNode("a"); }

  /** The page goes away. Whatever it still had on its way ends the way a closed page's requests do (a network
   *  failure; reads answered), so the writer settles each save's lane and its journal entry (optimisticFields)
   *  before the next run: an entry left open would hold the note's fields in the next run, and a lane left waiting
   *  would never send its saves. (In the app the send deadline ends such a request; here nothing would.) */
  async close(): Promise<void> {
    stopWriteRetry();
    for (let guard = 0; (world.inflight.length || world.reads.length) && guard < 20; guard++) {
      for (const request of world.inflight) world.failRetryably(request, "network");
      while (world.reads.length) world.answerRead(0);
      await act(async () => { for (let j = 0; j < 60; j++) await Promise.resolve(); });
      stopWriteRetry();
    }
    this.unmount();
    __resetDraftStateForTests();
    vi.useRealTimers();
  }

  /** One character at the person's caret, as a keystroke (a user transaction, not an outside sync). */
  async type(): Promise<void> {
    // No editor yet (the loading pane): the key reaches nothing, so it is not typing the person can expect to see.
    if (!this.editorShown) return;
    const ch = this.chars[(this.typed.length - START.length) % this.chars.length]!;
    act(() => {
      this.view.dispatch({ changes: { from: this.caret, insert: ch }, selection: { anchor: this.caret + 1 }, userEvent: "input.type" });
    });
    this.typed = this.typed.slice(0, this.caret) + ch + this.typed.slice(this.caret);
    this.caret += 1;
    await settle();
  }

  async autosave(): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); await settle(); }

  async deliver(index: number): Promise<void> {
    const open = world.inflight;
    const request = open[index % Math.max(open.length, 1)];
    if (!request) return;
    world.deliver(request);
    await settle();
  }

  /** The device asks /api/sync now: the answer is the server's rows at this moment. */
  ask(): void { this.answers.push(world.rows()); }

  /** A captured answer arrives (late, possibly after newer ones, possibly twice). */
  async answer(index: number, keep = false): Promise<void> {
    if (!this.answers.length) return;
    const at = index % this.answers.length;
    const rows = this.answers[at]!;
    if (!keep) this.answers.splice(at, 1);
    const upsert = projectPendingNoteText(rows, world.pending as never);
    // The worker's applySync writes the answer, with the queued writes laid over it, into the local copy first.
    for (const row of upsert) world.localText.set(row.id, row.markdown ?? "");
    const delta = {
      last_event_id: 0, nodes: { upsert, delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
      attributes: { upsert: [], delete: [] }, workspace: null,
    } as unknown as AppliedSyncDelta;
    act(() => { setData((data) => applySyncDelta(data, delta)); });
    await settle();
  }

  problems(step: string): string[] {
    if (!this.editorShown) return [];
    const doc = this.view.state.doc.toString();
    const head = this.view.state.selection.main.head;
    const out: string[] = [];
    if (doc !== this.typed) out.push(`after ${step}: the editor shows ${JSON.stringify(doc)}, typed ${JSON.stringify(this.typed)}`);
    if (head !== this.caret) out.push(`after ${step}: the caret is at ${head}, the person left it at ${this.caret}`);
    return out;
  }
}

const phone = new Phone();
beforeEach(async () => { await phone.open(); });
afterEach(async () => { await phone.close(); });

describe("typed text is never replaced by an older text (report 2026-11-19)", { timeout: 60_000 }, () => {
  it("the report: an answer asked after save 1 was answered, delivered while save 2 is on its way", async () => {
    const seen: string[] = [];
    const step = async (name: string, run: () => Promise<void> | void) => { await run(); seen.push(...phone.problems(name)); };
    await step("type 歷", () => phone.type());
    await step("autosave", () => phone.autosave());
    await step("save 1 answered", () => phone.deliver(0));
    await step("sync asked", () => phone.ask());
    await step("type 史", () => phone.type());
    await step("autosave", () => phone.autosave());
    await step("the answer arrives", () => phone.answer(0));
    // Review question 2: in this gap the LOCAL COPY holds save 2's text too. Every save is a queued row before it is
    // sent (#1888, writeQueue.recordWrite), so the worker lays it over the answer (pendingNoteProjection); before
    // #1888 an online save was not queued and the local copy went back to save 1's text here.
    expect(world.localText.get("a")).toBe(phone.typed);
    await step("save 2 answered", () => phone.deliver(0));
    // After the answer the writer mirrors the store row into the local copy: save 2's text (before this fix the
    // store row, and so the local copy, still held save 1's text here).
    expect(world.localText.get("a")).toBe(phone.typed);
    phone.ask();
    await step("the next answer arrives", () => phone.answer(0));
    expect(seen).toEqual([]);
    expect(world.server.get("a")!.markdown).toBe(`${START}歷史`);
  });

  it("a note opened before its text arrives: a key before the text, the first key after it, and an old re-read arriving late", async () => {
    await phone.close();
    await phone.open({ slim: true });
    const seen: string[] = [];
    const step = async (name: string, run: () => Promise<void> | void) => { if (seen.length) return; await run(); seen.push(...phone.problems(name)); };
    expect(phone.editorShown).toBe(false);
    await step("a key while the text is loading (reaches nothing)", () => phone.type());
    await step("the text arrives", () => phone.bodyArrives(0));
    expect(phone.editorShown).toBe(true);
    await step("first key", () => phone.type());
    await step("autosave", () => phone.autosave());
    // Read before the save reached the server, answered while it is still on its way.
    await step("the note is read again", () => phone.readAgain());
    await step("the re-read arrives while the save is on its way", () => phone.bodyArrives(0));
    // Read before the save reached the server, answered after the save's answer, nothing typed in between.
    await step("the note is read again", () => phone.readAgain());
    await step("save answered", () => phone.deliver(0));
    await step("a re-read from before the save arrives after its answer", () => phone.bodyArrives(0));
    await step("type", () => phone.type());
    await step("autosave", () => phone.autosave());
    await step("save answered", () => phone.deliver(0));
    expect(seen).toEqual([]);
    expect(world.server.get("a")!.markdown).toBe(phone.typed);
  });

  it("every order of saves, sync answers (late, duplicated) and typing keeps every character in place", async () => {
    // One typing session: three bursts, each followed by a pause (the autosave sends then). The server answers the
    // saves and two sync requests; the order of everything is random, an answer can only come after it was asked,
    // may come after newer ones, and one comes twice. A save is sent only after the previous one was answered
    // (draftActions), so "deliver" answers the oldest request on its way, if any. The run ends with everything
    // delivered and one more sync, and is checked after every event.
    //
    // Half the runs open the note with its text still on the server (review of #1900, round 2: a first key typed right
    // after the note opens, before or after its text arrives): hydrateNode's read is answered at a random point
    // ("body"), and the note is read again once while it is open ("readAgain", answered by a later "body").
    type Event = "type" | "deliver" | "ask" | "answer" | "answerTwice" | "body" | "readAgain";
    const events: Event[] = ["type", "type", "type", "deliver", "deliver", "deliver", "ask", "ask", "answer", "answer", "answerTwice", "body", "readAgain", "body"];
    const order = fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length });
    await fc.assert(fc.asyncProperty(order, fc.array(fc.nat(3), { minLength: events.length, maxLength: events.length }), fc.boolean(), async (steps, picks, slim) => {
      await phone.close();
      await phone.open({ slim });
      const seen: string[] = [];
      const run = async (event: Event, n: number) => {
        if (event === "type") { await phone.type(); await phone.autosave(); }
        else if (event === "deliver") await phone.deliver(0);
        else if (event === "ask") phone.ask();
        else if (event === "body") await phone.bodyArrives(n);
        else if (event === "readAgain") phone.readAgain();
        else await phone.answer(n, event === "answerTwice");
        seen.push(...phone.problems(event));
      };
      for (const [i, event] of steps.entries()) { await run(event, picks[i]!); if (seen.length) break; }
      for (let guard = 0; !seen.length && world.reads.length && guard < 10; guard++) await run("body", 0);
      for (let guard = 0; !seen.length && world.inflight.length && guard < 10; guard++) await run("deliver", 0);
      if (!seen.length) { phone.ask(); await run("answer", 99); }
      expect(seen, `${slim ? "slim open; " : ""}${steps.join(", ")}`).toEqual([]);
      expect(world.server.get("a")!.markdown).toBe(phone.typed);
    }), { seed: SEED, numRuns: RUNS, endOnFailure: true });
  });

  it("the editor's own guard: a row older than this editor's accepted save never reaches the draft, a newer one does", async () => {
    await phone.type(); await phone.autosave(); await phone.deliver(0);
    const accepted = phone.typed;
    const acceptedRow = getNode("a")!;
    const older = new Date(Date.parse(acceptedRow.updated_at!) - 1000).toISOString();
    // Whatever path put it there: the store row goes back to the text from before the save, with an earlier time.
    act(() => { setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === "a" ? { ...n, markdown: START, updated_at: older } : n) })); });
    await settle();
    expect(getAppState().overviewDraft).toBe(accepted);
    expect(phone.problems("an older row")).toEqual([]);
    // Another writer's newer text still reaches a clean editor (GAP-186).
    const newer = new Date(Date.parse(acceptedRow.updated_at!) + 1000).toISOString();
    act(() => { setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === "a" ? { ...n, markdown: `${accepted}\n別台`, updated_at: newer } : n) })); });
    await settle();
    expect(getAppState().overviewDraft).toBe(`${accepted}\n別台`);
    expect(phone.view.state.doc.toString()).toBe(`${accepted}\n別台`);
  });

  it("an outside text during an IME composition waits for its end, then arrives without moving the caret", async () => {
    // Save what is there, so the editor is clean and would take a newer text from another device at once.
    await phone.type(); await phone.autosave(); await phone.deliver(0);
    const shown = phone.typed;
    act(() => { phone.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await settle();
    // Another device adds a line at the top; the answer carrying it arrives mid-composition.
    const server = world.server.get("a")!;
    server.markdown = `另一台\n${server.markdown}`;
    server.at += 1;
    world.remoteWrites += 1;
    phone.ask();
    await phone.answer(0);
    expect(getNode("a")?.markdown).toBe(`另一台\n${shown}`);
    expect(phone.view.state.doc.toString()).toBe(shown);
    expect(getAppState().overviewDraft).toBe(shown);
    act(() => { phone.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    await settle();
    expect(phone.view.state.doc.toString()).toBe(`另一台\n${shown}`);
    expect(getAppState().overviewDraft).toBe(`另一台\n${shown}`);
    // The caret stays after the person's last character (it moves with the text inserted before it).
    expect(phone.view.state.selection.main.head).toBe("另一台\n".length + phone.caret);
  });

  it("a value that changes during a composition anyway is not applied until the composition ends", async () => {
    const editorOnly = render(<MarkdownEditor nodeKey="x" value="起" onChange={() => {}} nodes={[]} onMediaInsert={async () => null} />);
    const view = EditorView.findFromDOM(editorOnly.container.querySelector(".cm-editor") as HTMLElement)!;
    act(() => { view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    editorOnly.rerender(<MarkdownEditor nodeKey="x" value="起歷史" onChange={() => {}} nodes={[]} onMediaInsert={async () => null} />);
    await settle();
    expect(view.state.doc.toString()).toBe("起");
    act(() => { view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    await settle();
    expect(view.state.doc.toString()).toBe("起歷史");
    editorOnly.unmount();
  });
});
