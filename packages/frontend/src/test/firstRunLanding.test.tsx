// A first launch with example notes opens the welcome note (not a blank journal page),
// once; the app opening today's journal by itself says nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../lib/launchPreference", () => ({ getLaunchPreference: () => "today" as const }));

import { useLandingNote } from "../hooks/useLandingNote";
import { beginFirstRunLanding, consumeFirstRunLanding, finishFirstRunLanding } from "../lib/firstRunLanding";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";

const note = (id: string) => ({ id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", hidden: false });
const ui = { setMode: vi.fn(), setNotesView: vi.fn(), setOverviewMobileTab: vi.fn() };
const loc = { view: "notes", nodeId: null, lens: "editor" } as never;

beforeEach(() => { localStorage.clear(); resetAppState(); consumeFirstRunLanding(); vi.clearAllMocks(); });

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
