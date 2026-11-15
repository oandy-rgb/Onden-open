import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SuggestionsView } from "../lib/aiSuggestions";

// Accepting or rejecting an AI's suggestion is an online decision: the note is
// saved first (accepting writes it on the server), then one POST goes out with
// an Idempotency-Key, and a retry after a lost reply carries the same key.
// Nothing says "accepted" before the server answered; a place the server
// found changed is told to the person, not shown as done.
const liveChanged: Array<() => unknown> = [];
vi.mock("../lib/liveInvalidation", () => ({
  useLiveRefetch: (topic: string, refetch: () => unknown) => { if (topic === "changed") liveChanged.push(refetch); },
}));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { api, ApiError } = await import("../lib/api");
const { setAppState, getAppState } = await import("../lib/appStore");
const { setLocalePref } = await import("../lib/i18n");
const { drafts } = await import("../lib/data");
const { announceSuggestionsChanged } = await import("../lib/aiSuggestionsBus");
const { useAiSuggestions } = await import("../hooks/useAiSuggestions");

const apiMock = vi.mocked(api);
const NOTE = "# T\n\nalpha\n\nbeta\n";
const pending: SuggestionsView = {
  can_decide: true,
  suggestions: [{
    id: "s1", agent_actor_id: "a1", agent_name: "我的 Claude", session_id: null, created_at: "2026-10-30T00:00:00Z", older: false, skill: null,
    items: [
      { id: "i1", seq: 0, kind: "replace", base_text: "alpha", base_occurrence: 0, new_text: "ALPHA", status: "pending" },
      { id: "i2", seq: 1, kind: "replace", base_text: "beta", base_occurrence: 0, new_text: "BETA", status: "pending" },
    ],
  }],
};
const posts = () => apiMock.mock.calls.filter(([, init]) => init?.method === "POST");
const keyOf = (call: (typeof apiMock.mock.calls)[number]) => new Headers(call[1]?.headers).get("Idempotency-Key");

function route(handlers: { post?: () => Promise<unknown>; view?: SuggestionsView | { suggestions: never[]; can_decide: boolean } } = {}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return (handlers.post ?? (async () => ({ accepted: ["i1", "i2"], rejected: [], stale: [], void: [], alreadyDecided: [] })))();
    if (path.startsWith("/api/ai-suggestions?node_id=")) return handlers.view ?? pending;
    throw new Error(`unexpected ${path}`);
  });
}
const mount = (props: { canEdit?: boolean; online?: boolean; onNoteChanged?: () => void } = {}) =>
  renderHook(() => useAiSuggestions({ nodeId: "n1", markdown: NOTE, canEdit: props.canEdit ?? true, online: props.online ?? true, onNoteChanged: props.onNoteChanged }));

beforeEach(() => {
  apiMock.mockReset();
  setLocalePref("en");
  setAppState({ online: true });
  vi.spyOn(drafts, "flush").mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("an AI's suggestions in the open note", () => {
  it("tells the rest of the page once a decision went through (the inbox card follows), and not before", async () => {
    route();
    const { onSuggestionsChanged } = await import("../lib/aiSuggestionsBus");
    const heard = vi.fn();
    const off = onSuggestionsChanged(heard);
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    expect(heard).not.toHaveBeenCalled();
    await act(async () => { await result.current.decideAll("accept"); });
    expect(heard).toHaveBeenCalledWith({ nodeId: "n1", noteChanged: false, fromEditor: true });
    off();
  });

  it("loads what is pending and places it in the text", async () => {
    route();
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    expect(result.current.layout.places.map((p) => p.newText)).toEqual(["ALPHA", "BETA"]);
    expect(result.current.layout.places.every((p) => p.canAct)).toBe(true);
  });

  it("reads again when the info panel's AI answer filed or decided places, and tells the host the note changed only if it did", async () => {
    route();
    const onNoteChanged = vi.fn();
    const { result } = mount({ onNoteChanged });
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    route({ view: { suggestions: [], can_decide: true } });
    act(() => announceSuggestionsChanged("another-note", true)); // not this note: ignored
    act(() => announceSuggestionsChanged("n1", false));
    await waitFor(() => expect(result.current.layout.total).toBe(0));
    expect(onNoteChanged).not.toHaveBeenCalled();
    act(() => announceSuggestionsChanged("n1", true));
    expect(onNoteChanged).toHaveBeenCalledTimes(1);
  });

  it("looks nothing up offline, and the places cannot be decided", async () => {
    route();
    const { result } = mount({ online: false });
    await act(async () => {});
    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.layout.total).toBe(0);
  });

  it("accepting saves the note first, then POSTs once with an Idempotency-Key, then reads again and tells the host the note changed", async () => {
    route();
    const onNoteChanged = vi.fn();
    const { result } = mount({ onNoteChanged });
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    route({ view: { suggestions: [], can_decide: true } });
    await act(async () => { expect(await result.current.decide("s1", ["i1"], "accept")).toBe(true); });
    expect(drafts.flush).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    const [path, init] = posts()[0]!;
    expect(path).toBe("/api/ai-suggestions/s1/accept");
    expect(JSON.parse(init!.body as string)).toEqual({ item_ids: ["i1"] });
    expect(keyOf(posts()[0]!)).toBeTruthy();
    expect(onNoteChanged).toHaveBeenCalledTimes(1);
    expect(result.current.layout.total).toBe(0); // read again: nothing pending
  });

  it("rejecting writes nothing of the note: no save first, the note is not reported changed", async () => {
    route();
    const onNoteChanged = vi.fn();
    const { result } = mount({ onNoteChanged });
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    route({ post: async () => ({ accepted: [], rejected: ["i1", "i2"], stale: [], void: [], alreadyDecided: [] }) });
    await act(async () => { await result.current.decideAll("reject"); });
    expect(drafts.flush).not.toHaveBeenCalled();
    expect(JSON.parse(posts()[0]![1]!.body as string)).toEqual({ item_ids: ["i1", "i2"] });
    expect(posts()[0]![0]).toBe("/api/ai-suggestions/s1/reject");
    expect(onNoteChanged).not.toHaveBeenCalled();
  });

  it("sends nothing when the note could not be saved", async () => {
    route();
    vi.mocked(drafts.flush).mockResolvedValue(false);
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    await act(async () => { expect(await result.current.decide("s1", "all", "accept")).toBe(false); });
    expect(posts()).toHaveLength(0);
    expect(result.current.layout.places).toHaveLength(2);
  });

  it("a retry after a lost reply is the same decision: same key, places stay until the server answers", async () => {
    route({ post: async () => { throw new ApiError(503, "unavailable"); } });
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    await act(async () => { expect(await result.current.decide("s1", ["i1"], "accept")).toBe(false); });
    expect(result.current.layout.places).toHaveLength(2);
    route();
    await act(async () => { expect(await result.current.decide("s1", ["i1"], "accept")).toBe(true); });
    expect(posts()).toHaveLength(2);
    expect(keyOf(posts()[1]!)).toBe(keyOf(posts()[0]!));
  });

  it("a place the server found changed is told to the person", async () => {
    route({ post: async () => ({ accepted: [], rejected: [], stale: ["i1"], void: [], alreadyDecided: [] }) });
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    await act(async () => { await result.current.decide("s1", ["i1"], "accept"); });
    expect(getAppState().toasts.map((toast) => toast.message)).toContain("1 place had changed since the AI wrote it, so it wasn't applied.");
  });

  it("a person who may only read sees the places but cannot decide", async () => {
    route({ view: { ...pending, can_decide: false } });
    const { result } = mount();
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
    expect(result.current.layout.places.every((p) => !p.canAct)).toBe(true);
  });
});

describe("a suggestion an AI files while the note is open", () => {
  it("is read again on the live signal, so the bar shows it without reopening the note", async () => {
    route({ view: { suggestions: [], can_decide: true } });
    const { result } = mount();
    await waitFor(() => expect(apiMock.mock.calls.length).toBeGreaterThan(0));
    expect(result.current.layout.places).toHaveLength(0);
    route(); // the AI files its suggestion now
    expect(liveChanged.length).toBeGreaterThan(0);
    await act(async () => { await liveChanged[liveChanged.length - 1]!(); });
    await waitFor(() => expect(result.current.layout.places).toHaveLength(2));
  });
});
