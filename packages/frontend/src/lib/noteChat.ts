import { replaceWikilinks, splitWikilink, wikilinkTarget } from "@onden/markdown";
import { t } from "./i18n";
import type { ChatTurn } from "@onden/contract";
import { chooseTarget, handFailureText, noRoleText, type HandOptions, type HandPick, type HandTarget } from "./handToAi";
import { displayTitle } from "./noteLabel";

// The info panel's 「AI」 tab, without React (backend services/panelChat.ts is the other half):
// the scope chips, the `@` that adds one, what the answer links to, what the person reads
// while it works, and where an answer goes in the note. The conversation itself is server
// state (one panel_chat session per question); nothing here is kept on the device.

export const SCOPE_MAX = 8;
export const QUESTION_MAX = 2_000;

export type ScopeChip = { kind: "note" | "tag"; id: string; title: string };

/** Add a chip: not the open note (it is always in), not twice, not past the limit. */
export function addChip(chips: readonly ScopeChip[], chip: ScopeChip, openNoteId: string): ScopeChip[] {
  if (chip.kind === "note" && chip.id === openNoteId) return [...chips];
  if (chips.some((c) => c.kind === chip.kind && c.id === chip.id) || chips.length >= SCOPE_MAX) return [...chips];
  return [...chips, chip];
}
export const removeChip = (chips: readonly ScopeChip[], chip: Pick<ScopeChip, "kind" | "id">): ScopeChip[] =>
  chips.filter((c) => !(c.kind === chip.kind && c.id === chip.id));

export const chipsToScope = (chips: readonly ScopeChip[]) => ({
  scope_note_ids: chips.filter((c) => c.kind === "note").map((c) => c.id),
  scope_tag_ids: chips.filter((c) => c.kind === "tag").map((c) => c.id),
});

/** The `@word` being typed at the end of the question (start of text or after a space), or null. */
export function mentionQuery(text: string): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/u.exec(text);
  return match ? { query: match[2]!, start: match.index + match[1]!.length } : null;
}
/** The question without the `@word` that was just turned into a chip. */
export const withoutMention = (text: string, mention: { start: number }): string => text.slice(0, mention.start).replace(/\s+$/u, "");

/** Where a source link goes: the note, and the paragraph when the answer named one that exists. */
export const sourceTarget = (source: { node_id: string; block_id: string | null }) =>
  ({ nodeId: source.node_id, blockId: source.block_id });


export const turnIsOpen = (turn: Pick<ChatTurn, "status">): boolean => turn.status === "queued" || turn.status === "delivered" || turn.status === "running";

/** 「提了 N 處修改」 for the places still waiting; "" when nothing waits. */
export function suggestionLine(turn: Pick<ChatTurn, "suggestions">): string {
  const { pending, accepted, rejected } = turn.suggestions;
  if (pending > 0) return t("Suggested {n} changes", { n: pending });
  if (accepted + rejected > 0) return t("{n} changes decided", { n: accepted + rejected });
  return "";
}

/** One line on what the AI is doing now. */
export function stepLine(step: { what: "read" | "search" | "write"; title: string | null }): string {
  const name = step.title === null ? "" : displayTitle(step.title);
  if (step.what === "search") return t("Searching…");
  if (step.what === "write") return name ? t("Preparing a change to “{title}”…", { title: name }) : t("Preparing a change…");
  return name ? t("Reading “{title}”…", { title: name }) : t("Reading…");
}

/** A question nobody has picked up for this long means the computer that answers is probably not on. */
const NO_PICKUP_AFTER_MS = 45_000;

/** What an open question is waiting on, in plain words, from the status the session really reports
 *  (queued → delivered → running; only an API answer streams steps, so no tool use is claimed here).
 *  `short` is the same state for the panel's one-row bar. `stuck`: nobody picked it up for a long time. */
export function waitingLine(turn: Pick<ChatTurn, "status" | "runtime" | "created_at">, now: number): { text: string; short: string; stuck: boolean } {
  if (turn.runtime === "api") return { text: t("The AI is working…"), short: t("The AI is answering…"), stuck: false };
  if (turn.status === "running") return { text: t("Your AI is working on it…"), short: t("The AI is answering…"), stuck: false };
  if (turn.status === "delivered") return { text: t("Your AI has it and is getting started…"), short: t("The AI is answering…"), stuck: false };
  const waited = now - Date.parse(turn.created_at);
  if (Number.isFinite(waited) && waited > NO_PICKUP_AFTER_MS) {
    return { text: t("Nobody has picked this up yet. The computer that answers may not be on or online."), short: t("Waiting — your computer may be offline"), stuck: true };
  }
  return { text: t("Waiting for your computer to pick this up…"), short: t("Waiting for your computer…"), stuck: false };
}

/** The panel's one-row bar: the state in a few words. Pending: what it waits on; else the first words of the
 *  last answer; else the invitation. `streamed` is the text an API answer has so far. */
export function barLine(turns: readonly ChatTurn[], streamed: string, now: number): string {
  const open = turns.find(turnIsOpen);
  if (open) return streamed.trim() ? answerText(streamed).replace(/\s+/g, " ").trim() : waitingLine(open, now).short;
  const last = [...turns].reverse().find((x) => x.status === "completed" && x.reply);
  if (last) return answerText(last.reply!).replace(/\s+/g, " ").trim();
  return t("Ask about this note");
}

/** Why a question did not get an answer, in one sentence. */
export const chatFailureText = (code: string | null): string => handFailureText(code);

export type ChatEntry = { target: HandTarget | null; blocked: string | null };
/** Can the person ask here now, and which role and way would answer. `reasonText` words an unavailable way (settings' words). */
export function chatEntry(input: { online: boolean; options: HandOptions | null; pick?: HandPick; reasonText: (code: string | null) => string }): ChatEntry {
  if (!input.online) return { target: null, blocked: t("Asking the AI needs a connection.") };
  if (!input.options) return { target: null, blocked: null };
  const target = chooseTarget(input.options, input.pick);
  if (target) return { target, blocked: null };
  const first = input.options.roles[0];
  if (first && first.reason === null) {
    // The role is fine; no way of running it works now: say why for its default way.
    const way = first.runtimes.find((r) => r.kind === first.default_runtime) ?? first.runtimes[0];
    return { target: null, blocked: input.reasonText(way?.unavailable_reason ?? null) };
  }
  return { target: null, blocked: noRoleText(input.options) };
}

/** The answer as it goes in at the caret: set apart from what is there by a blank line. */
export const insertion = (answer: string): string => `\n\n${answer.trim()}\n`;

/** What is added at the end of `body` for this answer: the same as at the caret, minus the blank lines the end already has. */
export const additionAtEnd = (body: string, answer: string): string => {
  const gap = body === "" || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${gap}${answer.trim()}\n`;
};

/** The note's text without what was added, or null when it is not there exactly as it was added
 *  (the person has changed it since: it is left alone). The last copy goes when it was added twice. */
export function withoutAddition(body: string, added: string): string | null {
  const at = body.lastIndexOf(added);
  return at < 0 ? null : body.slice(0, at) + body.slice(at + added.length);
}

/** An answer for reading in the panel: `[[Title#^id|label]]` shows as its label or title (the links are listed under it). */
const answerText = (reply: string): string =>
  replaceWikilinks(reply, (body, full) => splitWikilink(body).alias?.trim() || wikilinkTarget(body) || full);
