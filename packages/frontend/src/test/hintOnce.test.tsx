// Hints shown once per account (hooks/useHintOnce, lib/hintsSeenStore): the
// device flags they replaced carry over, and a hint seen once stays seen.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});
vi.mock("../hooks/useModuleFilter", () => ({ useModuleFilter: () => () => false }));

import { useHintOnce } from "../hooks/useHintOnce";
import { useWelcomeBanner } from "../hooks/useWelcomeBanner";
import CommandPalette from "../components/CommandPalette";
import MarkdownEditor from "../components/MarkdownEditor";
import { hintsSeenStore, parseHintsSeen } from "../lib/hintsSeenStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { getPref, getPrefJson, PREFS, setPref } from "../lib/prefs";
import { createRef } from "react";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

beforeEach(async () => {
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset();
  sendWrite.mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
  bindAccountStorage("unit-test-account", "");
  // The store lives as long as the page: start each test from an empty account.
  hintsSeenStore.save(null);
  await hintsSeenStore.sync();
  serverPrefs = {};
  sendWrite.mockClear();
  resetAppState();
  setAppState({ online: true, data: { ...noWorkspaceData, nodes: [] } });
});

const seenLocally = () => getPrefJson(PREFS.hintsSeen) as { value: string[] | null } | null;

describe("parseHintsSeen", () => {
  it("keeps a list of ids, once each, and refuses anything else", () => {
    expect(parseHintsSeen(["a", "b", "a"])).toEqual(["a", "b"]);
    for (const bad of [null, "a", { a: 1 }, [""], [1], ["x".repeat(65)]]) expect(parseHintsSeen(bad)).toBeNull();
  });
});

describe("useHintOnce", () => {
  it("shows a new hint once the account's list is known, and not again after it is marked", async () => {
    const first = renderHook(() => useHintOnce("hashtag-to-scope"));
    await waitFor(() => expect(first.result.current.show).toBe(true));
    act(() => first.result.current.markSeen());
    expect(first.result.current.show).toBe(false);
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["hashtag-to-scope"]));
    first.unmount();
    expect(renderHook(() => useHintOnce("hashtag-to-scope")).result.current.show).toBe(false);
  });

  it("does not show a hint another device already marked", async () => {
    serverPrefs.hintsSeen = ["hashtag-to-scope"];
    await act(async () => { await hintsSeenStore.sync(); });
    const { result } = renderHook(() => useHintOnce("hashtag-to-scope"));
    expect(result.current.show).toBe(false);
  });

  it("marking a hint takes in what another device marked meanwhile", async () => {
    // This page synced before; another device has since shown hashtag-to-scope.
    serverPrefs.hintsSeen = ["hashtag-to-scope"];
    const welcome = renderHook(() => useHintOnce("welcome"));
    act(() => welcome.result.current.markSeen());
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["hashtag-to-scope", "welcome"]));
    await waitFor(() => expect(hintsSeenStore.get().dirty).toBe(false));
    expect(renderHook(() => useHintOnce("hashtag-to-scope")).result.current.show).toBe(false);
  });

  it("marking offline keeps it on this device and writes it back, merged with the server's, later", async () => {
    sendWrite.mockRejectedValue(new Error("offline"));
    serverPrefs.hintsSeen = ["other-device"];
    await act(async () => { await hintsSeenStore.sync(); });
    const { result } = renderHook(() => useHintOnce("hashtag-to-scope"));
    act(() => result.current.markSeen());
    await waitFor(() => expect(sendWrite).toHaveBeenCalled());
    expect(result.current.show).toBe(false);
    expect(seenLocally()).toMatchObject({ value: ["other-device", "hashtag-to-scope"], dirty: true });
    sendWrite.mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
    await act(async () => { await hintsSeenStore.sync(); });
    expect(serverPrefs.hintsSeen).toEqual(["other-device", "hashtag-to-scope"]);
  });

  it("a hint marked on a device that never saw the server's list does not erase it", async () => {
    sendWrite.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useHintOnce("b"));
    act(() => result.current.markSeen());
    await waitFor(() => expect(sendWrite).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    serverPrefs.hintsSeen = ["a"];
    await act(async () => { await hintsSeenStore.sync(); });
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["a", "b"]));
  });
});

describe("the old device flags move to the account", () => {
  it("welcome card: a dismissed flag stays dismissed, lands in the account, and the old key goes", async () => {
    setPref(PREFS.welcomeDismissed, "1");
    const { result } = renderHook(() => useWelcomeBanner({ refresh: async () => {}, setMode: vi.fn(), setNotesView: vi.fn() }));
    expect(result.current.visible).toBe(false);
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["welcome"]));
    expect(getPref(PREFS.welcomeDismissed)).toBeNull();
    // On a second device with no flag the card stays away too.
    expect(renderHook(() => useWelcomeBanner({ refresh: async () => {}, setMode: vi.fn(), setNotesView: vi.fn() })).result.current.visible).toBe(false);
  });

  it("welcome card: a new account sees it until it is dismissed, then everywhere never again", async () => {
    const { result, unmount } = renderHook(() => useWelcomeBanner({ refresh: async () => {}, setMode: vi.fn(), setNotesView: vi.fn() }));
    await waitFor(() => expect(result.current.visible).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.visible).toBe(false);
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["welcome"]));
    unmount();
    expect(renderHook(() => useWelcomeBanner({ refresh: async () => {}, setMode: vi.fn(), setNotesView: vi.fn() })).result.current.visible).toBe(false);
  });

  it("welcome card: a flag left at 0 is just dropped", async () => {
    setPref(PREFS.welcomeDismissed, "0");
    const { result } = renderHook(() => useWelcomeBanner({ refresh: async () => {}, setMode: vi.fn(), setNotesView: vi.fn() }));
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(getPref(PREFS.welcomeDismissed)).toBeNull();
    expect(serverPrefs.hintsSeen).toBeUndefined();
  });

  const palette = () => render(<CommandPalette open onClose={vi.fn()} query="" onQueryChange={vi.fn()} index={0} onIndexChange={vi.fn()}
    items={[]} inputRef={createRef<HTMLInputElement>()} searching={false} onSelect={vi.fn()} />);

  it("command palette hint: a dismissed flag keeps it hidden and lands in the account", async () => {
    setPref(PREFS.paletteHintDismissed, "1");
    palette();
    expect(screen.queryByRole("button", { name: "Dismiss hint" })).toBeNull();
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["palette-prefix"]));
    expect(getPref(PREFS.paletteHintDismissed)).toBeNull();
  });

  it("command palette hint: shows for a new account and dismissing it is per account", async () => {
    const view = palette();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss hint" }));
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["palette-prefix"]));
    view.unmount();
    palette();
    expect(screen.queryByRole("button", { name: "Dismiss hint" })).toBeNull();
  });
});

describe("the #word → tag-the-paragraph note in the editor", () => {
  function editor(value: string) {
    const utils = render(<MarkdownEditor nodeKey="n1" noteTitle="My note" value={value} onChange={vi.fn()} nodes={[]} workspaceTags={[]} onMediaInsert={vi.fn(async () => null)} />);
    const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
    const type = (text: string) => act(() => {
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    });
    return { ...utils, view, type, text: () => view.state.doc.toString() };
  }
  const note = () => screen.queryByText("Tag this paragraph?");

  it("appears after '#word ' once, changes the text on the button, and never returns for the account", async () => {
    await act(async () => { await hintsSeenStore.sync(); });
    const e = editor("二分搜尋 ");
    e.type("#考點");
    expect(note()).toBeNull();
    e.type(" ");
    expect(note()).not.toBeNull();
    // The word shows as a tag chip, never as the `{}` syntax; the button says what it does.
    expect(screen.getByText("考點").className).toContain("ui-chip");
    expect(note()!.closest(".hashtag-hint")!.textContent).not.toMatch(/\{考點\}/);
    expect(screen.getByText("Next time, type { to tag a paragraph.")).toBeTruthy();
    fireEvent.click(screen.getByText("Add tag"));
    expect(e.text()).toBe("二分搜尋 {考點} ");
    expect(note()).toBeNull();
    await waitFor(() => expect(serverPrefs.hintsSeen).toEqual(["hashtag-to-scope"]));
    // Typing another #word, here or on another device, does not offer again.
    e.type("#再一個 ");
    expect(note()).toBeNull();
  });

  it("closing it, or ignoring it and typing on, also uses up the one time", async () => {
    await act(async () => { await hintsSeenStore.sync(); });
    const e = editor("");
    e.type("想法 #甲 ");
    fireEvent.click(screen.getByLabelText("Close"));
    expect(note()).toBeNull();
    expect(e.text()).toBe("想法 #甲 ");
    e.type("#乙 ");
    expect(note()).toBeNull();
  });

  it("goes away when the word is typed over, without changing the text", async () => {
    await act(async () => { await hintsSeenStore.sync(); });
    const e = editor("");
    e.type("想法 #甲 ");
    expect(note()).not.toBeNull();
    act(() => e.view.dispatch({ changes: { from: 3, to: 5, insert: "" }, userEvent: "delete.backward" }));
    expect(note()).toBeNull();
  });

  it("does not appear for a heading, a code block or a link anchor", async () => {
    await act(async () => { await hintsSeenStore.sync(); });
    const e = editor("");
    e.type("# 標題 ");
    e.type("\n\nhttps://x.test/a#b ");
    e.type("\n\n```\n#code ");
    expect(note()).toBeNull();
    expect(hintsSeenStore.get().value ?? []).not.toContain("hashtag-to-scope");
  });
});
