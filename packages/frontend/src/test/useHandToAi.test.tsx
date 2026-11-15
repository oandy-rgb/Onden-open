import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { HandOptions } from "../lib/handToAi";

// 「交給 AI」: starting goes through the online write path after the note is saved;
// the API way streams a preview that ends as the SAME text the suggestion carries;
// the other ways show the @ai card's status; cancelling leaves no suggestion and
// does not refresh the suggestion list; offline or a note that can't be saved sends nothing.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { api } = await import("../lib/api");
const { setAppState } = await import("../lib/appStore");
const { setLocalePref } = await import("../lib/i18n");
const { drafts } = await import("../lib/data");
const { useHandToAi } = await import("../hooks/useHandToAi");

const apiMock = vi.mocked(api);
const OPTIONS: HandOptions = {
  can_hand_off: true,
  roles: [{
    actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
    runtimes: [{ kind: "api", available: true }, { kind: "mcp", available: true }],
  }],
};
const CATALOGUE = ["rewrite", "shorten", "expand", "fix", "translate", "explain"].map((id) => ({ id, name: id, description: "", kind: "builtin", aiUse: id !== "translate" }));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  close() { this.readyState = 2; }
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

let sessionBody: Record<string, unknown> = {};
function route() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/ai/hand-to-ai")) return OPTIONS;
    if (path === "/api/skills") return { skills: CATALOGUE };
    if (path === "/api/ai/selection-actions" && init?.method === "POST") return { session_id: "s1", created: true };
    if (path.endsWith("/cancel")) return { session: { id: "s1", status: "cancelled" }, changed: true };
    if (path === "/api/agent-sessions/s1") return { session: sessionBody };
    throw new Error(`unexpected ${path}`);
  });
}
const posts = () => apiMock.mock.calls.filter(([, init]) => init?.method === "POST");
const bodyOf = (path: string) => JSON.parse(String(posts().find(([p]) => p === path)![1]!.body));
const START = { skill: "shorten", skillName: "Shorten", text: "一段很長的文字", at: { x: 10, y: 20 } };
const mount = (props: { canEdit?: boolean; online?: boolean; onDone?: () => void } = {}) =>
  renderHook(() => useHandToAi({ nodeId: "n1", canEdit: props.canEdit ?? true, online: props.online ?? true, onDone: props.onDone ?? (() => {}) }));

beforeEach(() => {
  apiMock.mockReset();
  setLocalePref("en");
  setAppState({ online: true });
  vi.spyOn(drafts, "flush").mockResolvedValue(true);
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.last = null;
  sessionBody = { id: "s1", status: "queued", fail_code: null, agent_name: "小助手", delivered_at: null };
  route();
});
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function ready(props?: Parameters<typeof mount>[0]) {
  const hook = mount(props);
  await act(async () => { await hook.result.current.load(); });
  await waitFor(() => expect(hook.result.current.target).not.toBeNull());
  return hook;
}

describe("the API way", () => {
  it("sends exactly the words and the chosen role and way, then shows the stream and ends with the same text", async () => {
    const onDone = vi.fn();
    const { result } = await ready({ onDone });
    await act(async () => { await result.current.start(START); });
    expect(bodyOf("/api/ai/selection-actions")).toMatchObject({ agent_actor_id: "r1", node_id: "n1", skill: "shorten", text: "一段很長的文字", runtime: "api" });
    expect(bodyOf("/api/ai/selection-actions").instruction).toBeUndefined();
    expect(FakeEventSource.last!.url).toContain("/api/ai/selection-actions/s1/stream");
    expect(result.current.run).toMatchObject({ phase: "streaming", line: "小助手 · API key" });

    act(() => { FakeEventSource.last!.send({ kind: "text", text: "短" }); FakeEventSource.last!.send({ kind: "text", text: "一點" }); });
    expect(result.current.run!.text).toBe("短一點"); // what the suggestion will replace the words with
    expect(onDone).not.toHaveBeenCalled();
    act(() => { FakeEventSource.last!.send({ kind: "end", status: "completed", fail_code: null }); });
    expect(result.current.run!.phase).toBe("done");
    expect(onDone).toHaveBeenCalledTimes(1); // the suggestion list is read again: the diff appears in the note
  });

  it("a failed stream says why in a sentence and leaves nothing to refresh", async () => {
    const onDone = vi.fn();
    const { result } = await ready({ onDone });
    await act(async () => { await result.current.start(START); });
    act(() => { FakeEventSource.last!.send({ kind: "end", status: "failed", fail_code: "selection_changed" }); });
    expect(result.current.run).toMatchObject({ phase: "failed", failCode: "selection_changed" });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("cancelling asks the server, shows cancelled, and the suggestion list is not read again", async () => {
    const onDone = vi.fn();
    const { result } = await ready({ onDone });
    await act(async () => { await result.current.start(START); });
    await act(async () => { await result.current.cancel(); });
    expect(posts().some(([p]) => p === "/api/agent-sessions/s1/cancel")).toBe(true);
    expect(result.current.run!.phase).toBe("cancelled");
    expect(FakeEventSource.last!.readyState).toBe(2);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a one-time sentence travels with the request and is kept nowhere else", async () => {
    const { result } = await ready();
    await act(async () => { await result.current.start({ ...START, skill: "rewrite", skillName: "Custom", instruction: "改成口語" }); });
    expect(bodyOf("/api/ai/selection-actions")).toMatchObject({ skill: "rewrite", instruction: "改成口語" });
    expect(JSON.stringify(localStorage)).not.toContain("改成口語");
  });
});

describe("the other ways of running", () => {
  it("do not stream: the card says what the @ai card says, and a finished one refreshes the suggestions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onDone = vi.fn();
    const { result } = await ready({ onDone });
    act(() => result.current.setPick({ runtime: "mcp" }));
    await act(async () => { await result.current.start(START); });
    expect(bodyOf("/api/ai/selection-actions")).toMatchObject({ runtime: "mcp" });
    expect(FakeEventSource.last).toBeNull();
    await waitFor(() => expect(result.current.run).toMatchObject({ phase: "waiting", session: { status: "queued" } }));
    expect(result.current.run!.line).toBe("小助手 · Your own AI");
    sessionBody = { ...sessionBody, status: "completed" };
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(result.current.run!.phase).toBe("done");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("what is sent, and what is not", () => {
  it("nothing is sent when the note can't be saved first; the person's text stays", async () => {
    vi.spyOn(drafts, "flush").mockResolvedValue(false);
    const { result } = await ready();
    await act(async () => { await result.current.start(START); });
    expect(posts().filter(([p]) => p === "/api/ai/selection-actions")).toHaveLength(0);
    expect(result.current.run).toBeNull();
  });

  it("offline: the entry is stopped with a reason and nothing is read or sent", async () => {
    const { result } = mount({ online: false });
    expect(result.current.entry).toMatchObject({ shown: true });
    expect(result.current.entry.blocked).toMatch(/connection/);
    await act(async () => { await result.current.load(); await result.current.start(START); });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("a note that can't be edited has no entry", () => {
    const { result } = mount({ canEdit: false });
    expect(result.current.entry.shown).toBe(false);
  });

  it("an action the person switched off for the AI is not in the list", async () => {
    const { result } = await ready();
    await waitFor(() => expect(result.current.actions.length).toBeGreaterThan(0));
    expect(result.current.actions.map((a) => a.id)).toEqual(["rewrite", "shorten", "expand", "fix", "explain"]);
  });
});
