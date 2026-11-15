import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AgentSessionBrief } from "../lib/agentMentions";

// Sending a mention is an online write: the note is saved first, then
// POST /api/agent-sessions goes out once with an Idempotency-Key, and a retry
// after a lost reply carries the same key. The card says "sent" only after the
// server answered.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { api, ApiError } = await import("../lib/api");
const { setAppState } = await import("../lib/appStore");
const { setLocalePref } = await import("../lib/i18n");
const { drafts } = await import("../lib/data");
const { useAgentMentions } = await import("../hooks/useAgentMentions");
const { replaceAllAnchors } = await import("../lib/blockAnchorStore");
const { holdAnchored } = await import("./helpers/anchoredText");

const apiMock = vi.mocked(api);
const queued: AgentSessionBrief = {
  id: "s1", anchor_block_id: "k1", revision: 1, status: "queued", fail_code: null, agent_actor_id: "a1",
  agent_handle: "claude", agent_name: "我的 Claude", created_at: "2026-10-24T08:00:00Z", delivered_at: null, acked_at: null,
};
const mentionables = { agents: [{ actor_id: "a1", handle: "claude", name: "我的 Claude", available: true, reason: null }], default_actor_id: "a1" };
const posts = () => apiMock.mock.calls.filter(([, init]) => init?.method === "POST");
const keyOf = (call: (typeof apiMock.mock.calls)[number]) => new Headers(call[1]?.headers).get("Idempotency-Key");

function route(handlers: { post?: () => Promise<unknown>; sessions?: AgentSessionBrief[] } = {}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    // By default the server accepts the request and answers with a queued session of that block.
    if (init?.method === "POST") {
      return (handlers.post ?? (async () => ({ created: true, session: { ...queued, anchor_block_id: JSON.parse(init.body as string).block_id ?? "k9" } })))();
    }
    if (path.includes("/mentionables")) return mentionables;
    if (path.startsWith("/api/agent-sessions?node_id=")) return { sessions: handlers.sessions ?? [] };
    throw new Error(`unexpected ${path}`);
  });
}
/** The note's text lives in state, as the editor's draft does: a write to it shows up in the next render. */
const mount = (initial: string, props: { canEdit?: boolean; online?: boolean } = {}) =>
  renderHook(() => {
    const [markdown, setMarkdown] = useState(initial);
    return { markdown, ...useAgentMentions({ nodeId: "n1", markdown, canEdit: props.canEdit ?? true, online: props.online ?? true, onMarkdownChange: setMarkdown }) };
  });

beforeEach(() => {
  apiMock.mockReset();
  setLocalePref("zh-TW");
  setAppState({ online: true });
  vi.spyOn(drafts, "flush").mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); replaceAllAnchors([]); });

describe("sending an @ai mention", () => {
  it("saves the note, then POSTs the mention by its words once with an Idempotency-Key, writes nothing into the text, and only then says sent", async () => {
    route();
    const { result } = mount("@ai 幫我整理這段");
    await waitFor(() => expect(result.current.known).not.toBeNull());
    expect(result.current.cards[0]).toMatchObject({ tone: "idle" });

    await act(async () => { await result.current.act(result.current.cards[0]!.key, "send"); });
    expect(drafts.flush).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    const [path, init] = posts()[0]!;
    expect(path).toBe("/api/agent-sessions");
    // no id goes into the note: a block with no anchor yet is named by its words, and the server anchors it
    expect(result.current.markdown).toBe("@ai 幫我整理這段");
    expect(JSON.parse(init!.body as string)).toEqual({ node_id: "n1", block_text: "@ai 幫我整理這段" });
    expect(keyOf(posts()[0]!)).toBeTruthy();
    // the card follows the anchor the server made, before the sync has brought it
    expect(result.current.cards[0]).toMatchObject({ tone: "waiting", text: "已送出，AI 還沒接上。" });
  });

  it("sends the anchor id when the mention's block has one", async () => {
    route();
    const { result } = mount(holdAnchored("n1", "@ai 好 ^k1"));
    await act(async () => { await result.current.act(result.current.cards[0]!.key, "send"); });
    expect(JSON.parse(posts()[0]![1]!.body as string)).toEqual({ node_id: "n1", block_id: "k1" });
  });

  it("a retry after a lost reply is the same request: same key, still not shown as sent", async () => {
    route({ post: async () => { throw new ApiError(503, "unavailable"); } });
    const { result } = mount("@ai 幫我整理這段");
    const key = () => result.current.cards[0]!.key;
    await act(async () => { await result.current.act(key(), "send"); });
    expect(result.current.cards[0]).toMatchObject({ tone: "idle" });
    route();
    await act(async () => { await result.current.act(key(), "send"); });
    expect(result.current.markdown).toBe("@ai 幫我整理這段"); // nothing is ever written into the text
    expect(posts()).toHaveLength(2);
    expect(keyOf(posts()[1]!)).toBe(keyOf(posts()[0]!));
    expect(result.current.cards[0]).toMatchObject({ tone: "waiting" });
  });

  it("sends nothing when the note could not be saved", async () => {
    route();
    vi.mocked(drafts.flush).mockResolvedValue(false);
    const { result } = mount("@ai 幫我整理這段");
    await act(async () => { await result.current.act(result.current.cards[0]!.key, "send"); });
    expect(posts()).toHaveLength(0);
    expect(result.current.cards[0]).toMatchObject({ tone: "idle" });
  });

  it("offline: the send button is disabled and says it needs a connection", () => {
    route();
    const { result } = mount("@ai 幫我整理這段", { online: false });
    expect(result.current.cards[0]).toMatchObject({ text: "送出需要連線。" });
    expect(result.current.cards[0]!.actions[0]).toMatchObject({ disabled: true });
  });
});

describe("handing a note to an AI with a skill", () => {
  it("writes @ai /[[skill]] under the text and sends it as one request", async () => {
    route();
    const { result } = mount("我的讀書筆記");
    act(() => result.current.handOff("摘要論文"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(result.current.markdown).toBe("我的讀書筆記\n\n@ai /[[摘要論文]]\n");
    expect(JSON.parse(posts()[0]![1]!.body as string)).toMatchObject({ node_id: "n1" });
    expect(keyOf(posts()[0]!)).toBeTruthy();
    await waitFor(() => expect(result.current.cards[0]).toMatchObject({ tone: "waiting" }));
  });

  it("sends nothing when the note could not be saved, but leaves the mention to send by hand", async () => {
    route();
    vi.mocked(drafts.flush).mockResolvedValue(false);
    const { result } = mount("筆記");
    act(() => result.current.handOff("摘要論文"));
    await waitFor(() => expect(drafts.flush).toHaveBeenCalled());
    expect(posts()).toHaveLength(0);
    expect(result.current.markdown).toContain("@ai /[[摘要論文]]");
  });
});

describe("a request already sent", () => {
  it("shows where it stands when the note opens, and cancel and retry post to the session", async () => {
    route({ sessions: [queued] });
    const { result } = mount(holdAnchored("n1", "@ai 好 ^k1"));
    await waitFor(() => expect(result.current.cards[0]).toMatchObject({ tone: "waiting" }));

    route({ post: async () => ({ session: { ...queued, status: "cancelled", fail_code: "cancelled_by_user" } }) });
    await act(async () => { await result.current.act("k1", "cancel"); });
    expect(posts()[0]![0]).toBe("/api/agent-sessions/s1/cancel");
    expect(result.current.cards[0]).toMatchObject({ text: "已取消。" });

    route({ post: async () => ({ created: true, session: { ...queued, revision: 2 } }) });
    await act(async () => { await result.current.act("k1", "retry"); });
    expect(posts()[1]![0]).toBe("/api/agent-sessions");
    expect(JSON.parse(posts()[1]![1]!.body as string)).toEqual({ node_id: "n1", block_id: "k1", resend: true });
    expect(result.current.cards[0]).toMatchObject({ tone: "waiting" });
  });

  it("a reader sees the state but has no buttons", async () => {
    route({ sessions: [{ ...queued, status: "failed", fail_code: "timed_out" }] });
    const { result } = mount(holdAnchored("n1", "@ai 好 ^k1"), { canEdit: false });
    await waitFor(() => expect(result.current.cards[0]).toMatchObject({ tone: "failed", text: "AI 沒有回應，稍後再試。", actions: [] }));
  });
});
