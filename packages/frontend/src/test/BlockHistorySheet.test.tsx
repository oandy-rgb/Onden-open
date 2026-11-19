import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { reads } from "../lib/data";
import { getAppState, setAppState } from "../lib/appStore";
import { blockHistoryPreview } from "../lib/blockHistoryPreview";
import { paragraphFrame } from "../lib/editorParagraphFrame";
import { useBlockHistory } from "../components/useBlockHistory";
import type { NoteVersion } from "../lib/data/reads";

// The signed-in person is "Ann" (the rows' default author).
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => ({ user: { id: "u1", name: "Ann" } }) }));

// jsdom has no layout: CodeMirror measures text through these on Range.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const row = (id: string, markdown: string, over: Partial<NoteVersion> = {}): NoteVersion =>
  ({ id, title: "N", markdown, changed_at: "2026-10-23T02:10:00Z", actor_name: "Ann", actor_type: "user", ...over });

const NOW = "# Plans\n\nFirst paragraph stays ^keep1\n\nBuy oat milk and eggs today ^tgt\n\nLast paragraph stays";
// Newest first, like the server.
const ROWS = [
  row("v3", NOW),
  row("v2", NOW.replace("Buy oat milk and eggs today", "Buy oat milk today"), { actor_name: "Claude", actor_type: "ai_agent" }),
  row("v1", NOW.replace("Buy oat milk and eggs today", "Buy milk")),
];

let view: EditorView;
function Harness({ readOnly = false, openNoteHistory }: { readOnly?: boolean; openNoteHistory?: (id: string | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    view = new EditorView({ state: EditorState.create({ doc: NOW, extensions: [blockHistoryPreview, paragraphFrame] }), parent: host.current! });
    viewRef.current = view;
    return () => view.destroy();
  }, []);
  const history = useBlockHistory({ viewRef, nodeKey: "n1", readOnly, onOpenNoteHistory: openNoteHistory });
  return (
    <>
      <div ref={host} />
      <button onClick={() => history.open!(NOW.indexOf("oat milk") + 2)}>open</button>
      {history.sheet}
    </>
  );
}

const open = async (props: Parameters<typeof Harness>[0] = {}) => {
  render(<Harness {...props} />);
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("History of this part");
};
const oldWording = () => document.querySelector(".cm-block-history-old")?.textContent ?? null;

beforeEach(() => {
  setAppState({ toasts: [] });
  vi.spyOn(reads.notes, "rawVersions").mockResolvedValue(ROWS);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("BlockHistorySheet", () => {
  it("names the heading and the count, starts on the current wording and frames it", async () => {
    await open();
    expect(screen.getByText("Under “Plans” · 3 versions")).toBeTruthy();
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(screen.getByText("This is the current text")).toBeTruthy();
    expect(screen.queryByText("Use this version")).toBeNull();
    expect(document.querySelector(".cm-paragraph-frame")).not.toBeNull();
    expect(document.querySelector(".cm-paragraph-frame")!.textContent).toContain("Buy oat milk and eggs today");
    expect(oldWording()).toBeNull();
  });

  it("steps to older wordings, shows each in place without writing, and says how it differs", async () => {
    await open();
    fireEvent.click(screen.getByText("Older"));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Compared with this version, the text now has this more: “and eggs”")).toBeTruthy();
    await waitFor(() => expect(oldWording()).toBe("Buy oat milk today"));
    fireEvent.click(screen.getByText("Older"));
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByText("Written here first")).toBeTruthy();
    await waitFor(() => expect(oldWording()).toBe("Buy milk"));
    expect((screen.getByText("Older").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(view.state.doc.toString()).toBe(NOW);
    fireEvent.click(screen.getByText("Newer"));
    fireEvent.click(screen.getByText("Newer"));
    await waitFor(() => expect(oldWording()).toBeNull());
  });

  it("closing with 完成 leaves the note as it was and clears the preview", async () => {
    await open();
    fireEvent.click(screen.getByText("Older"));
    await waitFor(() => expect(oldWording()).not.toBeNull());
    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByText("History of this part")).toBeNull();
    expect(oldWording()).toBeNull();
    expect(view.state.doc.toString()).toBe(NOW);
  });

  it("「用這個版本」 replaces only this paragraph (its ^id stays), closes, and 復原 puts it back", async () => {
    await open();
    fireEvent.click(screen.getByText("Older"));
    fireEvent.click(screen.getByText("Older"));
    fireEvent.click(screen.getByText("Use this version"));
    expect(view.state.doc.toString()).toBe(NOW.replace("Buy oat milk and eggs today", "Buy milk"));
    expect(screen.queryByText("History of this part")).toBeNull();
    expect(oldWording()).toBeNull();
    const toast = getAppState().toasts.at(-1)!;
    expect(toast.message).toMatch(/^This part was changed back to how it was /);
    act(() => { toast.action!.onClick(); });
    expect(view.state.doc.toString()).toBe(NOW);
  });

  it("復原 refuses when the paragraph was edited after the swap", async () => {
    await open();
    fireEvent.click(screen.getByText("Older"));
    fireEvent.click(screen.getByText("Use this version"));
    act(() => { view.dispatch({ changes: { from: view.state.doc.toString().indexOf("Buy"), insert: "Please " } }); });
    const edited = view.state.doc.toString();
    act(() => { getAppState().toasts.at(-1)!.action!.onClick(); });
    expect(view.state.doc.toString()).toBe(edited);
    expect(getAppState().toasts.at(-1)!.kind).toBe("error");
  });

  it("offers no 「用這個版本」 when the note is read-only", async () => {
    await open({ readOnly: true });
    fireEvent.click(screen.getByText("Older"));
    expect(screen.queryByText("Use this version")).toBeNull();
  });

  it("opens the whole note's history at the save being looked at", async () => {
    const openNote = vi.fn();
    await open({ openNoteHistory: openNote });
    fireEvent.click(screen.getByText("Older"));
    fireEvent.click(screen.getByText("See the whole note as it was"));
    expect(openNote).toHaveBeenCalledWith("v2");
    expect(oldWording()).toBeNull();
  });

  it("says so when the history cannot be read", async () => {
    vi.spyOn(reads.notes, "rawVersions").mockRejectedValue(new Error("boom"));
    await open();
    expect(await screen.findByText("Couldn't load this paragraph's history")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  // Who each wording is from: the same rule as the note's history (lib/history/historyAuthor.ts). 「你」 only for the
  // signed-in person; a temporary session (kind 'session', no name) and a removed member (no row: no name) are not "you".
  it.each([
    ["the signed-in person", { actor_name: "Ann", actor_type: "user", actor_kind: "human" }, "You"],
    ["another member", { actor_name: "Bea", actor_type: "user", actor_kind: "human" }, "Bea"],
    ["a temporary session", { actor_name: null, actor_type: "user", actor_kind: "session" }, "A temporary session"],
    ["a removed member", { actor_name: null, actor_type: "user", actor_kind: "human" }, "Someone"],
  ] as const)("names %s as the author of a wording", async (_who, author, label) => {
    vi.spyOn(reads.notes, "rawVersions").mockResolvedValue([ROWS[0]!, row("v2", ROWS[1]!.markdown, author), ROWS[2]!]);
    await open();
    fireEvent.click(screen.getByText("Older"));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(document.querySelector(".bh-actor")!.textContent).toBe(label);
    if (label !== "You") expect(screen.queryByText("You")).toBeNull();
  });
});
