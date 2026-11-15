import { beforeEach, describe, expect, it } from "vitest";
import { detectPopupTrigger } from "./editorCompletion";
import { setLocalePref } from "./i18n";
import {
  failureText, handOffMention, looksLikeDate, mentionCards, mentionRows, sessionCard, skillRows, skillsFor,
  type AgentSessionBrief, type CardInputs, type MentionAgents, type NoteSkill,
} from "./agentMentions";

beforeEach(() => setLocalePref("zh-TW"));

const agent = (over: Partial<MentionAgents["agents"][number]> = {}) =>
  ({ actor_id: "a1", handle: "claude", name: "我的 Claude", available: true, reason: null, ...over });
const known = (agents = [agent()]): MentionAgents => ({ agents, defaultActorId: agents[0]?.actor_id ?? null });
const session = (over: Partial<AgentSessionBrief> = {}): AgentSessionBrief => ({
  id: "s1", anchor_block_id: "k1", revision: 1, status: "queued", fail_code: null, agent_actor_id: "a1",
  agent_handle: "claude", agent_name: "我的 Claude", created_at: "2026-10-24T08:00:00Z", delivered_at: null, acked_at: null, ...over,
});
const inputs = (over: Partial<CardInputs> = {}): CardInputs => ({
  markdown: "@ai 幫我整理這段", known: known(), sessions: new Map(),
  online: true, canEdit: true, now: Date.parse("2026-10-24T08:00:30Z"), busy: null, ...over,
});

describe("the @ trigger", () => {
  it("opens where a word starts, and carries what was typed", () => {
    expect(detectPopupTrigger("@")).toMatchObject({ type: "mention", query: "", markerIndex: 0 });
    expect(detectPopupTrigger("請 @cl")).toMatchObject({ type: "mention", query: "cl", markerIndex: 2 });
    expect(detectPopupTrigger("- [ ] @a")).toMatchObject({ type: "mention", query: "a" });
    expect(detectPopupTrigger("（@")).toMatchObject({ type: "mention" });
  });

  it("leaves e-mail addresses, dates, code and the other menus alone", () => {
    expect(detectPopupTrigger("me@example")).toBeNull();
    expect(detectPopupTrigger("開會 @today")).toBeNull();
    expect(detectPopupTrigger("開會 @tomorrow")).toBeNull();
    expect(detectPopupTrigger("到期 @2026-10-24")).toBeNull();
    expect(detectPopupTrigger("code @a", true)).toBeNull();
    expect(detectPopupTrigger("[[note @a")).toMatchObject({ type: "wikilink" });
    expect(detectPopupTrigger("/")).toMatchObject({ type: "slash" });
    expect(detectPopupTrigger("#ta")).toBeNull();
    expect(looksLikeDate("2026")).toBe(true);
    expect(looksLikeDate("claude")).toBe(false);
  });
});

describe("the @ menu rows", () => {
  it("lists @ai first, then the AIs with their own handle", () => {
    const rows = mentionRows("", known([agent(), agent({ actor_id: "a2", handle: "scribe", name: "抄寫員" })]));
    expect(rows.map((r) => (r.kind === "agent" ? r.handle : "hint"))).toEqual(["ai", "claude", "scribe"]);
    expect(rows[0]).toMatchObject({ detail: "預設：我的 Claude", available: true });
  });

  it("filters by what was typed", () => {
    const both = known([agent(), agent({ actor_id: "a2", handle: "scribe", name: "抄寫員" })]);
    expect(mentionRows("sc", both).map((r) => r.kind === "agent" && r.handle)).toEqual(["scribe"]);
    expect(mentionRows("a", both).map((r) => r.kind === "agent" && r.handle)).toEqual(["ai"]);
    expect(mentionRows("zzz", both)).toEqual([]);
  });

  it("says where to set an AI up when there is none, instead of staying silent", () => {
    const [row] = mentionRows("", { agents: [], defaultActorId: null });
    expect(row).toMatchObject({ kind: "hint" });
    expect(row!.kind === "hint" && row!.text).toContain("設定 › AI");
  });

  it("says so when it can't tell (offline), and greys out an AI that can't be used", () => {
    expect(mentionRows("", null)[0]).toMatchObject({ kind: "hint" });
    const off = mentionRows("", known([agent({ available: false, reason: "disabled" })]));
    expect(off[0]).toMatchObject({ handle: "ai", available: false, detail: "已關閉" });
    expect(off[1]).toMatchObject({ handle: "claude", available: false });
  });
});

// A mention's block is named by its anchor: `k1` starts at the `@ai 好` paragraph (the text carries no id).
const K1 = [{ id: "k1", from: 0, to: 5 }];

describe("the card under a mention", () => {
  it("offers to send a mention nobody has sent, and says nothing goes out before that", () => {
    const [card] = mentionCards(inputs());
    expect(card).toMatchObject({ tone: "idle", text: "還沒送出。按下送出之前，不會有任何內容交給 AI。" });
    expect(card!.actions).toEqual([{ action: "send", label: "送出給 AI", busy: false, disabled: false }]);
    expect(card!.at).toBe("@ai 幫我整理這段".length);
  });

  it("explains instead of offering when the send can't work", () => {
    const blocked = (over: Partial<CardInputs>) => mentionCards(inputs(over))[0]!;
    expect(blocked({ online: false })).toMatchObject({ text: "送出需要連線。" });
    expect(blocked({ online: false }).actions[0]).toMatchObject({ disabled: true });
    expect(blocked({ markdown: "@ai" }).text).toBe("請在 @ 後面寫下要 AI 做什麼。");
    // a skill is itself the request
    expect(blocked({ markdown: "@ai /[[整理]]" }).actions[0]).toMatchObject({ action: "send", disabled: false });
    expect(blocked({ known: { agents: [], defaultActorId: null } }).text).toContain("設定 › AI");
    expect(blocked({ known: known([agent({ available: false, reason: "agent_cannot_write" })]) }).text).toContain("共享空間");
    expect(blocked({ known: known([agent({ available: false, reason: "disabled" })]) }).text).toContain("已關閉");
  });

  it("is honest that a queued request has no AI behind it yet", () => {
    const [card] = mentionCards(inputs({ markdown: "@ai 好", anchors: K1, sessions: new Map([["k1", session()]]) }));
    expect(card).toMatchObject({ tone: "waiting", text: "已送出，AI 還沒接上。" });
    expect(card!.actions.map((a) => a.action)).toEqual(["cancel"]);
  });

  it("words every state without a code, an id or the server's text", () => {
    const now = Date.parse("2026-10-24T08:01:00Z");
    const text = (over: Partial<AgentSessionBrief>) => sessionCard(session(over), now, null);
    expect(text({ status: "delivered", delivered_at: "2026-10-24T08:00:55Z" }).text).toBe("我的 Claude 收到了。");
    expect(text({ status: "delivered", delivered_at: "2026-10-24T08:00:30Z" }).text).toBe("我的 Claude 收到了，但還沒有回應。");
    expect(text({ status: "running" })).toMatchObject({ tone: "working", text: "我的 Claude 處理中…" });
    expect(text({ status: "completed" })).toMatchObject({ tone: "done", text: "我的 Claude 已在下方回覆。", actions: [] });
    expect(text({ status: "failed", fail_code: "timed_out" })).toMatchObject({ tone: "failed", text: "AI 沒有回應，稍後再試。" });
    expect(text({ status: "failed", fail_code: "timed_out" }).actions).toEqual([{ action: "retry", label: "重試", busy: false }]);
    expect(text({ status: "cancelled", fail_code: "cancelled_by_user" })).toMatchObject({ text: "已取消。" });
    expect(text({ status: "cancelled", fail_code: "superseded" }).text).toBe("已被較新的請求取代。");
    for (const code of ["timed_out", "credit_exhausted", "rate_limited", "space_unavailable", "totally_new_code", null]) {
      expect(failureText(code)).not.toMatch(/[a-z]+_[a-z]+/);
    }
    expect(failureText("totally_new_code")).toBe("AI 沒能完成這次請求，稍後再試。");
  });

  it("shows the state to a reader but gives the buttons only to someone who can edit", () => {
    const [card] = mentionCards(inputs({ markdown: "@ai 好", anchors: K1, canEdit: false, sessions: new Map([["k1", session({ status: "failed", fail_code: "timed_out" })]]) }));
    expect(card).toMatchObject({ tone: "failed", actions: [] });
    expect(mentionCards(inputs({ canEdit: false }))).toEqual([]);
  });

  it("only draws for an AI: @someone else, a date or an e-mail gets no card", () => {
    expect(mentionCards(inputs({ markdown: "@john 你看一下\n\n開會 @today\n\nme@ai.com" }))).toEqual([]);
    expect(mentionCards(inputs({ markdown: "@claude 整理" }))).toHaveLength(1);
  });

  it("marks the button in progress", () => {
    const [card] = mentionCards(inputs({ busy: { key: "text:@ai 幫我整理這段", action: "send" } }));
    expect(card!.actions[0]).toMatchObject({ busy: true });
  });
});

describe("the skill menu", () => {
  const skill = (over: Partial<NoteSkill> = {}): NoteSkill => ({ id: "k1", name: "摘要論文", description: "三行摘要", appliesTo: ["tag-paper"], ...over });

  it("opens after @name and a space, on a /, and leaves other slashes alone", () => {
    expect(detectPopupTrigger("@ai /")).toMatchObject({ type: "skill", query: "", markerIndex: 4 });
    expect(detectPopupTrigger("請 @ai /摘")).toMatchObject({ type: "skill", query: "摘" });
    expect(detectPopupTrigger("@claude  /x")).toMatchObject({ type: "skill", query: "x" });
    expect(detectPopupTrigger("@ai /[[摘要")).toMatchObject({ type: "wikilink" });
    expect(detectPopupTrigger("@ai 看 a/b")).toBeNull();
    expect(detectPopupTrigger("me@ai.com /x")).toBeNull();
    expect(detectPopupTrigger("/")).toMatchObject({ type: "slash" });
  });

  it("lists matching skills, and says what to do when there are none or they can't be read", () => {
    expect(skillRows("摘", [skill(), skill({ id: "k2", name: "寫日記" })])).toEqual([{ kind: "skill", title: "摘要論文", detail: "三行摘要" }]);
    expect(skillRows("zzz", [skill()])).toEqual([]);
    expect(skillRows("", [])[0]).toMatchObject({ kind: "hint" });
    expect(skillRows("", null)[0]).toMatchObject({ kind: "hint" });
  });

  it("offers a skill on notes with one of its tags, and writes it as a wikilink mention", () => {
    const skills = [skill(), skill({ id: "k2", name: "寫日記", appliesTo: ["tag-diary"] }), skill({ id: "k3", name: "通用", appliesTo: [] })];
    expect(skillsFor(skills, ["tag-paper", "other"]).map((s) => s.name)).toEqual(["摘要論文"]);
    expect(skillsFor(skills, [])).toEqual([]);
    expect(handOffMention("摘要論文")).toBe("@ai /[[摘要論文]]");
  });
});

describe("an AI that only suggests keeps its reply off the note", () => {
  beforeEach(() => setLocalePref("en"));
  const done = session({ status: "completed", reply_markdown: "Four." });
  it("shows the reply with a button that files it as a suggestion", () => {
    expect(sessionCard(done, 0, null)).toMatchObject({
      tone: "done", text: "我的 Claude replied. Put the reply into the note?", detail: "Four.", actions: [{ action: "insert", label: "Insert into note" }],
    });
  });
  it("waits for the person once filed, and reads as replied once it is in the note", () => {
    expect(sessionCard(done, 0, null, { inNote: false, waiting: true })).toMatchObject({ text: "我的 Claude's reply is waiting for you to accept it in the note.", actions: [] });
    expect(sessionCard(done, 0, null, { inNote: true, waiting: false })).toMatchObject({ text: "我的 Claude replied below.", actions: [] });
  });
  it("an AI that wrote its reply into the note says so as before", () => {
    expect(sessionCard({ ...done, reply_markdown: null }, 0, null)).toMatchObject({ text: "我的 Claude replied below.", actions: [] });
  });
  it("the card under the mention carries the reply and offers it only to someone who can edit", () => {
    const withReply = new Map([["k1", done]]);
    expect(mentionCards(inputs({ markdown: "@ai 好", anchors: K1, sessions: withReply }))[0]).toMatchObject({ detail: "Four.", actions: [{ action: "insert" }] });
    expect(mentionCards(inputs({ markdown: "@ai 好", anchors: K1, sessions: withReply, canEdit: false }))[0]!.actions).toEqual([]);
    expect(mentionCards(inputs({ markdown: "@ai 好", anchors: K1, sessions: withReply, waitingReplies: new Set(["s1"]) }))[0]).toMatchObject({ actions: [] });
    expect(mentionCards(inputs({ markdown: "@ai 好\n\n> **x**", anchors: [{ id: "k1", from: 0, to: 5 }, { id: "k1r", from: 7, to: 14 }], sessions: withReply }))[0]).toMatchObject({ actions: [], text: "我的 Claude replied below." });
  });
});
