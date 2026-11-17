// A first launch with example notes opens the welcome note (not a blank journal page),
// once; the app opening today's journal by itself says nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../lib/launchPreference", () => ({ getLaunchPreference: () => "today" as const }));

import { useLandingNote } from "../hooks/useLandingNote";
import { beginFirstRunLanding, consumeFirstRunLanding, finishFirstRunLanding } from "../lib/firstRunLanding";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import * as prefs from "../lib/prefs";

const note = (id: string) => ({ id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", hidden: false });
const ui = { setMode: vi.fn(), setNotesView: vi.fn(), setOverviewMobileTab: vi.fn() };
const loc = { view: "notes", nodeId: null, lens: "editor" } as never;

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); resetAppState(); consumeFirstRunLanding(); vi.clearAllMocks(); });

describe("useLandingNote on a brand-new workspace", () => {
  it("waits for the examples, then opens the first one instead of today's journal", () => {
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => null);
    setAppState({ bootstrapped: true, membershipGated: false, data: { ...noWorkspaceData, nodes: [] } });
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    act(() => { beginFirstRunLanding(); setAppState({ data: { ...noWorkspaceData, nodes: [note("w1")] } as never }); });
    expect(openNote).not.toHaveBeenCalled();
    expect(openDailyNote).not.toHaveBeenCalled();
    act(() => finishFirstRunLanding("w1"));
    expect(openNote).toHaveBeenCalledWith("w1");
    expect(openDailyNote).not.toHaveBeenCalled();
  });

  it("starts today's journal without announcing it when there is no welcome note", () => {
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => null);
    setAppState({ bootstrapped: true, membershipGated: false, data: { ...noWorkspaceData, nodes: [note("a")] } as never });
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    expect(openDailyNote).toHaveBeenCalledWith({ announce: false });
  });
});

// With notes in the workspace the launch never ends on an empty editor.
describe("useLandingNote when its setting has nothing to open", () => {
  const dated = (id: string, updated_at: string) => ({ ...note(id), updated_at });

  it("opens the note left open last time when today's note could not be started", async () => {
    vi.spyOn(prefs, "getPref").mockImplementation((pref) => pref === prefs.PREFS.lastLocation ? "?node=b" : null);
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => null);
    setAppState({ bootstrapped: true, membershipGated: false, data: { ...noWorkspaceData, nodes: [dated("a", "2026-11-02"), dated("b", "2026-11-01")] } as never });
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    await act(async () => {});
    expect(openNote).toHaveBeenCalledWith("b");
  });

  it("else opens the note changed most recently, never a hidden one", async () => {
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => null);
    setAppState({ bootstrapped: true, membershipGated: false, data: { ...noWorkspaceData, nodes: [dated("a", "2026-11-02"), dated("b", "2026-11-01"), { ...dated("h", "2026-11-09"), hidden: true }] } as never });
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    await act(async () => {});
    expect(openNote).toHaveBeenCalledWith("a");
  });

  // A board's id is no note, and a note made elsewhere is not in a cached bootstrap yet.
  it("keeps a selection whose id is not among the loaded notes (a board, a note not loaded yet)", async () => {
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => "today");
    setAppState({ bootstrapped: true, membershipGated: false, selectedId: "board-or-new-note", data: { ...noWorkspaceData, nodes: [note("a")] } as never } as never);
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    await act(async () => {});
    expect(openDailyNote).not.toHaveBeenCalled();
    expect(openNote).not.toHaveBeenCalled();
  });

  it("keeps a selection that exists", () => {
    const openNote = vi.fn(); const openDailyNote = vi.fn(async () => "today");
    setAppState({ bootstrapped: true, membershipGated: false, selectedId: "a", data: { ...noWorkspaceData, nodes: [note("a")] } as never } as never);
    renderHook(() => useLandingNote({ initialLocation: loc, ui, openNote, openDailyNote }));
    expect(openDailyNote).not.toHaveBeenCalled();
    expect(openNote).not.toHaveBeenCalled();
  });
});
