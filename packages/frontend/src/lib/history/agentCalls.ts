// An AI agent's tool call as History shows it: one plain sentence, and the
// change the call made is its own event, so a successful write call folds into
// that event instead of repeating it. Successful read-only calls never reach
// History (routes/events.ts); the audit table keeps them. Raw tool names,
// token ids and arguments live only in the row's collapsed technical details.
import { t } from "../i18n";
import { agentLabel } from "../actorLabel";
import type { LiveEvent } from "../liveEvent";
import type { SentenceContext } from "./eventSentence";

/** What a tool does, as past tense and as an attempt ("wanted to …"). The read
 *  tools matter only when one fails. `{title}` is the note or a stand-in. */
const TOOL_PHRASES: Record<string, { did: string; tried: string }> = {
  createNode: { did: "created {title}", tried: "create {title}" },
  updateNode: { did: "edited {title}", tried: "edit {title}" },
  applyTag: { did: "tagged {title}", tried: "tag {title}" },
  removeTag: { did: "removed a tag from {title}", tried: "remove a tag from {title}" },
  proposeTagPack: { did: "proposed a tag pack", tried: "propose a tag pack" },
  getNode: { did: "read {title}", tried: "read {title}" },
  getAttachment: { did: "read an attachment of {title}", tried: "read an attachment of {title}" },
  searchNodes: { did: "searched notes", tried: "search notes" },
  semanticSearch: { did: "searched notes", tried: "search notes" },
  queryView: { did: "read a view", tried: "read a view" },
  suggestLinks: { did: "looked for links", tried: "look for links" },
};

export function isAgentToolEvent(e: LiveEvent): boolean {
  return e.event_type === "AGENT_TOOL_CALLED" || e.event_type === "AGENT_TOOL_FAILED";
}

export function toolNameOf(e: LiveEvent): string {
  const fromMeta = e.tx_meta?.tool_name;
  return typeof fromMeta === "string" ? fromMeta : e.target_id;
}

/** The note ids the call named (its audited `ids` arguments), in argument order. */
function namedIds(e: LiveEvent): string[] {
  const ids = (e.tx_meta?.args as { ids?: Record<string, unknown> } | undefined)?.ids ?? {};
  return Object.values(ids).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));
}

/** The acting agent's display name; a generic one until the actor list loads. */
export function agentName(e: LiveEvent, ctx: SentenceContext): string {
  return agentLabel(ctx.agentNameOf?.(e.actor_id));
}

/** The first note the call named that is still known, quoted. */
function calledNoteTitle(e: LiveEvent, ctx: SentenceContext): string | null {
  for (const id of namedIds(e)) {
    const title = ctx.titleOf(id);
    if (title !== undefined) return `「${title}」`;
  }
  return null;
}

/** Why a call failed, in words. The server records the error message only. */
function failureReason(e: LiveEvent): string {
  const message = String(e.payload?.message ?? "");
  if (e.payload?.scope_rejected === true || /permission|forbidden|not allowed|denied|scope|unauthori/i.test(message)) {
    return t("had no permission");
  }
  if (/rate|too many/i.test(message)) return t("called too often");
  return t("it did not work");
}

/** "The AI edited 「X」" or "The AI wanted to edit 「X」, but had no permission". */
export function agentToolSentence(e: LiveEvent, ctx: SentenceContext): string {
  const phrase = TOOL_PHRASES[toolNameOf(e)];
  const title = calledNoteTitle(e, ctx) ?? t("a note");
  const agent = agentName(e, ctx);
  if (e.event_type === "AGENT_TOOL_FAILED") {
    const action = phrase ? t(phrase.tried, { title }) : t("use a tool");
    return t("{agent} wanted to {action}, but {reason}", { agent, action, reason: failureReason(e) });
  }
  const action = phrase ? t(phrase.did, { title }) : t("used a tool");
  return t("{agent} {action}", { agent, action });
}

/** How far before a tool call's audit row (a later event id) its change can sit. */
const RESULT_WINDOW = 20;

/** Does `candidate` look like the change `call` made? Same agent, committed
 *  just before the audit row, and either stamped with the same tool name or
 *  about a note the call named. */
function isResultOf(candidate: LiveEvent, call: LiveEvent): boolean {
  if (isAgentToolEvent(candidate) || candidate.actor_id !== call.actor_id) return false;
  if (candidate.id >= call.id || call.id - candidate.id > RESULT_WINDOW) return false;
  return candidate.tx_meta?.tool_name === toolNameOf(call) || namedIds(call).includes(candidate.target_id);
}

/** Drop each successful write call whose own change event is in the feed; the
 *  change carries the agent's name (`eventSentence` prefixes AI actors). Calls
 *  with no change event in view (a proposal, an older page) stay as sentences. */
export function foldAgentCalls(events: LiveEvent[]): LiveEvent[] {
  return events.filter((call) => call.event_type !== "AGENT_TOOL_CALLED"
    || !events.some((candidate) => isResultOf(candidate, call)));
}
