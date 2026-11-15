// @mentions of an AI in a note, as the person sees them (docs/architecture/
// proposals/agent-mentions-2026-10-22.md §1). Pure: which agents the `@` menu
// lists, what sits under a mention in each state, and the plain sentence for
// every way a request can end. The server (routes/agentSessions.ts) owns what
// is allowed; this file only words it. Nothing here shows a code, an id or the
// server's own message (AGENTS.md, 使用者介面文字).

import { AI_MENTION_ALIAS, findMentions, type Mention } from "@onden/markdown";
import type { AnchorSpan } from "./blockAnchorStore";
import { t } from "./i18n";
import { containsTitle } from "./noteSearch";
import type { SessionStatus } from "@onden/contract";


/** One request to an AI, as GET /api/agent-sessions lists it. */
export type AgentSessionBrief = {
  id: string;
  anchor_block_id: string;
  revision: number;
  status: SessionStatus;
  fail_code: string | null;
  agent_actor_id: string;
  agent_handle: string | null;
  agent_name: string | null;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  /** An AI set to suggest keeps its reply here instead of writing it into the note; null otherwise. */
  reply_markdown?: string | null;
};

export type MentionableAgent = {
  actor_id: string;
  handle: string;
  name: string;
  available: boolean;
  reason: "disabled" | "agent_cannot_write" | "not_agents_owner" | null;
};

/** What GET /api/nodes/:id/mentionables answered; null while unknown (not loaded, offline). */
export type MentionAgents = { agents: MentionableAgent[]; defaultActorId: string | null };

export const isOpenSession = (status: SessionStatus): boolean => status === "queued" || status === "delivered" || status === "running";

// ── the `@` menu ────────────────────────────────────────────────────────────

export type MentionRow =
  /** `@ai` or an agent's own handle. `detail` is what to show beside it. */
  | { kind: "agent"; handle: string; detail: string; available: boolean }
  /** Nothing to pick: says where an AI is set up. */
  | { kind: "hint"; text: string };

/** `@today`, `@2026-10-24` and the like are dates (quick capture, tasks), not an AI. */
export function looksLikeDate(query: string): boolean {
  return /^\d/.test(query) || ["today", "tomorrow", "yesterday"].includes(query.toLowerCase());
}

const unavailableText = (reason: MentionableAgent["reason"]): string => {
  switch (reason) {
    case "disabled": return t("Switched off");
    case "agent_cannot_write": return t("Can't write in this space");
    case "not_agents_owner": return t("Not yours to send to");
    default: return "";
  }
};

/** Rows for what follows the typed `@`. `@ai` is first and stands for the
 *  default AI of this space; each AI with its own handle follows. */
export function mentionRows(query: string, known: MentionAgents | null): MentionRow[] {
  const q = query.toLowerCase();
  if (!known) return [{ kind: "hint", text: t("Can't check which AI is available right now. Try again when you're online.") }];
  if (known.agents.length === 0) {
    return [{ kind: "hint", text: t("No AI is set up yet. Add one in Settings › AI, then turn on its @ mention.") }];
  }
  const standIn = known.agents.find((a) => a.actor_id === known.defaultActorId) ?? null;
  const rows: MentionRow[] = [];
  if (AI_MENTION_ALIAS.startsWith(q)) {
    rows.push({
      kind: "agent", handle: AI_MENTION_ALIAS, available: standIn?.available ?? false,
      detail: standIn ? (standIn.available ? t("Default: {name}", { name: standIn.name }) : unavailableText(standIn.reason)) : "",
    });
  }
  for (const agent of known.agents) {
    if (agent.handle === AI_MENTION_ALIAS || !agent.handle.startsWith(q)) continue;
    rows.push({ kind: "agent", handle: agent.handle, available: agent.available, detail: agent.available ? agent.name : `${agent.name} · ${unavailableText(agent.reason)}` });
  }
  return rows;
}

// ── the skill menu: `@ai /` ─────────────────────────────────────────────────

/** A skill note of the person's, as GET /api/skills lists it (kind "note"). */
export type NoteSkill = { id: string; name: string; description: string; appliesTo: string[]; /** 「給 AI 用」: the AI may pick it itself (off: only when named). */ aiUse?: boolean };

export type SkillRow =
  | { kind: "skill"; title: string; detail: string }
  | { kind: "hint"; text: string };

/** Rows for what follows `@ai /`. Only skill notes can be named (the server
 *  resolves `/[[title]]` to the sender's own skill note); a built-in skill can't. */
export function skillRows(query: string, skills: readonly NoteSkill[] | null | undefined): SkillRow[] {
  if (skills === undefined) return [{ kind: "hint", text: t("Loading…") }];
  if (!skills) return [{ kind: "hint", text: t("Can't load your skills right now. Try again when you're online.") }];
  const q = query.toLowerCase();
  const rows: SkillRow[] = skills
    .filter((skill) => containsTitle(q, skill.name))
    .map((skill) => ({ kind: "skill", title: skill.name, detail: skill.description }));
  if (skills.length === 0) {
    return [{ kind: "hint", text: t("You have no skills yet. Choose “Use as a skill” in a note's menu, and keep it in a space that lets AI read notes.") }];
  }
  return rows;
}

/** The skills that offer themselves on `tagIds`' notes (frontmatter `applies_to`). */
export function skillsFor(skills: readonly NoteSkill[], tagIds: readonly string[]): NoteSkill[] {
  const own = new Set(tagIds);
  return skills.filter((skill) => skill.appliesTo.some((id) => own.has(id)));
}

/** The mention a skill button writes: the skill is the whole request. */
export const handOffMention = (skillTitle: string): string => `@${AI_MENTION_ALIAS} /[[${skillTitle}]]`;

// ── under a mention ─────────────────────────────────────────────────────────

export type MentionAction = "send" | "cancel" | "retry" | "insert";

/** What is drawn under one mention (editorMentions.ts). */
export type MentionCard = {
  /** Offset in the note where the card goes: the end of the mention's block. */
  at: number;
  /** Identifies the mention across edits: its `^id`, else its text. */
  key: string;
  tone: "idle" | "waiting" | "working" | "done" | "failed";
  text: string;
  /** More under the text: an AI's reply, shown until it is in the note. */
  detail?: string;
  /** Buttons, in order. `busy` shows the action in progress and ignores taps. */
  actions: Array<{ action: MentionAction; label: string; busy?: boolean; disabled?: boolean }>;
};

/** The plain sentence for a request that did not finish. A code the app does
 *  not know reads as the general one: the person never sees the code. */
export function failureText(code: string | null): string {
  switch (code) {
    case "timed_out": return t("The AI didn't answer. Try again later.");
    case "agent_disabled": return t("This AI was switched off.");
    case "credit_exhausted": return t("The AI has used up its allowance for now.");
    case "rate_limited": return t("The AI is busy. Try again in a while.");
    case "authentication_failed": return t("The AI's sign-in has expired.");
    case "reply_rejected": return t("The AI's answer couldn't be written into this note.");
    case "space_unavailable":
    case "cannot_read_note": return t("The AI can no longer read or write in this note.");
    case "superseded": return t("Replaced by a newer request.");
    default: return t("The AI couldn't finish this request. Try again later.");
  }
}

/** How long a delivered request may stay unanswered before we say so (proposal §1.4). */
export const NO_REPLY_AFTER_MS = 10_000;

const SEND: MentionCard["actions"][number] = { action: "send", label: "" };

/** The card for a mention that has a request, in the wording of proposal §1.4.
 *  No runner is connected on the live server yet, so a request that nobody
 *  picked up says exactly that instead of looking like work in progress. */
export function sessionCard(
  session: AgentSessionBrief, now: number, busy: MentionAction | null, reply: { inNote: boolean; waiting: boolean } = { inNote: false, waiting: false },
): Pick<MentionCard, "tone" | "text" | "detail" | "actions"> {
  const name = session.agent_name ?? t("The AI");
  const cancel = { action: "cancel" as const, label: t("Cancel"), busy: busy === "cancel" };
  const retry = (label: string) => ({ action: "retry" as const, label, busy: busy === "retry" });
  switch (session.status) {
    case "queued": return { tone: "waiting", text: t("Sent. The AI isn't connected yet."), actions: [cancel] };
    case "delivered": {
      const silent = session.delivered_at && now - Date.parse(session.delivered_at) > NO_REPLY_AFTER_MS;
      return { tone: "waiting", text: silent ? t("{name} received it but hasn't answered yet.", { name }) : t("{name} received it.", { name }), actions: [cancel] };
    }
    case "running": return { tone: "working", text: t("{name} is working on it…", { name }), actions: [cancel] };
    case "completed": {
      // An AI that only suggests keeps its reply off the note: the person puts it in, as one suggestion to accept.
      if (!session.reply_markdown || reply.inNote) return { tone: "done", text: t("{name} replied below.", { name }), actions: [] };
      if (reply.waiting) return { tone: "done", text: t("{name}'s reply is waiting for you to accept it in the note.", { name }), actions: [] };
      return {
        tone: "done", text: t("{name} replied. Put the reply into the note?", { name }), detail: session.reply_markdown,
        actions: [{ action: "insert", label: t("Insert into note"), busy: busy === "insert" }],
      };
    }
    case "failed": return { tone: "failed", text: failureText(session.fail_code), actions: [retry(t("Try again"))] };
    case "cancelled": return { tone: "idle", text: session.fail_code === "superseded" ? failureText("superseded") : t("Cancelled."), actions: [retry(t("Send again"))] };
  }
}

/** Why a mention can't be sent yet, or null when it can. */
function sendBlocker(mention: Mention, known: MentionAgents | null, online: boolean): string | null {
  if (!online) return t("Sending needs a connection.");
  if (!mention.prompt && !mention.leadIn && !mention.skill) return t("Write what you want after the @mention.");
  if (!known) return null; // unknown: the server decides and says why
  const agent = mention.handle === AI_MENTION_ALIAS
    ? known.agents.find((a) => a.actor_id === known.defaultActorId) ?? null
    : known.agents.find((a) => a.handle === mention.handle) ?? null;
  if (!agent) return mention.handle === AI_MENTION_ALIAS ? t("No AI is set up yet. Add one in Settings › AI, then turn on its @ mention.") : null;
  switch (agent.reason) {
    case null: return null;
    case "disabled": return t("This AI is switched off. Turn it on in Settings › AI.");
    case "agent_cannot_write": return t("The AI can't write in this note's space. Use a shared space that lets AI read notes, and add the AI to it.");
    case "not_agents_owner": return t("Only the owner of this AI can send it requests.");
  }
}

/** Does `@handle` point at an AI (so the mention gets a card), as far as we know? */
function isAgentHandle(handle: string, known: MentionAgents | null): boolean {
  return handle === AI_MENTION_ALIAS || (known?.agents.some((a) => a.handle === handle) ?? false);
}

/** The anchor id of the quoted reply block the server writes under a mention (backend replyBlockId). */
const replyBlockId = (anchor: string, revision: number): string => `${anchor}r${revision > 1 ? revision : ""}`;

/** The key a mention is tracked by: its anchor id (a mention gets one when it is sent), else its text. */
export const mentionKey = (markdown: string, mention: Mention): string =>
  mention.blockId ?? `text:${markdown.slice(mention.blockStart, mention.blockEnd).trim()}`;

export type CardInputs = {
  markdown: string;
  /** The note's paragraphs (lib/blockAnchorStore anchorSpansOf): what says which block a mention is, and whether a reply is in the note. */
  anchors?: readonly AnchorSpan[];
  known: MentionAgents | null;
  /** The newest request of each mention, by its anchor id. */
  sessions: ReadonlyMap<string, AgentSessionBrief>;
  online: boolean;
  canEdit: boolean;
  now: number;
  /** The mention (by key) whose action is in progress. */
  busy: { key: string; action: MentionAction } | null;
  /** Sessions whose reply is already a pending suggestion in this note. */
  waitingReplies?: ReadonlySet<string>;
};

/** One card per mention that points at an AI. */
export function mentionCards(input: CardInputs): MentionCard[] {
  const { markdown, anchors = [], known, sessions, online, canEdit, now, busy, waitingReplies } = input;
  const cards: MentionCard[] = [];
  for (const mention of findMentions(markdown, anchors)) {
    if (!isAgentHandle(mention.handle, known)) continue;
    const key = mentionKey(markdown, mention);
    const working = busy?.key === key ? busy.action : null;
    const session = mention.blockId ? sessions.get(mention.blockId) : undefined;
    const base = { at: mention.blockEnd, key };
    if (session) {
      const reply = { inNote: anchors.some((a) => a.id === replyBlockId(session.anchor_block_id, session.revision)), waiting: waitingReplies?.has(session.id) ?? false };
      const card = sessionCard(session, now, working, reply);
      // Nobody but an editor changes a note's requests; everyone who reads sees where they stand.
      cards.push({ ...base, ...card, actions: canEdit ? card.actions.map((a) => (a.action === "retry" || a.action === "insert" ? { ...a, disabled: !online } : a)) : [] });
      continue;
    }
    if (!canEdit) continue;
    const blocker = sendBlocker(mention, known, online);
    cards.push({
      ...base, tone: "idle",
      text: blocker ?? t("Not sent yet. Nothing goes to the AI until you send it."),
      actions: [{ ...SEND, label: t("Send to AI"), busy: working === "send", disabled: blocker !== null }],
    });
  }
  return cards;
}

/** What the editor needs from the host to offer and draw @mentions. */
export type MentionsHost = {
  cards: readonly MentionCard[];
  /** Run a card's button for the mention with this key. Stable across renders. */
  onAction(key: string, action: MentionAction): void;
  /** The `@` menu's rows for what was typed after the `@`. */
  rows(query: string): MentionRow[];
  /** The `@ai /` menu's rows for what was typed after the `/`. */
  skillRows(query: string): SkillRow[];
  /** A menu opened: refresh what it lists (which AI can be asked, or the skills). */
  onMenuOpen(menu: "mention" | "skill"): void;
};
