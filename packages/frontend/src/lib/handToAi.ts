import { t } from "./i18n";
import { failureText, sessionCard, type AgentSessionBrief, type MentionCard } from "./agentMentions";

// 「交給 AI」: hand a selection or a paragraph to an AI role and get ONE pending
// suggestion back (docs/agents/decisions-ai-collaboration.md, 批 6). This file is
// the rules, without React: which actions exist, which role and way of running a
// request goes to, and what the person reads while it works.

/** The server's runtime kinds: api and mcp. */
export type HandRuntime = "api" | "mcp" | (string & Record<never, never>);

/** The ready-made actions, in the order the menu shows them. Each is a built-in
 *  skill of the same id (backend harness/builtinSkills.ts); there is no stored
 *  "default prompt". One the person switched off for the AI in Settings is not offered. */
export const HAND_ACTIONS = [
  { id: "rewrite", label: "Rewrite" },
  { id: "shorten", label: "Shorten" },
  { id: "expand", label: "Expand" },
  { id: "fix", label: "Fix grammar" },
  { id: "translate", label: "Translate" },
  { id: "explain", label: "Explain" },
] as const;

export type HandRole = {
  actor_id: string; handle: string; name: string;
  default_runtime: HandRuntime;
  runtimes: Array<{ kind: HandRuntime; available: boolean; unavailable_reason?: string | null }>;
  /** Why the role can't take it now; null: it can. */
  reason: "disabled" | "agent_cannot_write" | "not_agents_owner" | null;
  model_name: string | null;
};
export type HandOptions = { can_hand_off: boolean; roles: HandRole[] };

/** What the person picked for this once with 「⋯」; nothing picked means the role's own default. */
export type HandPick = { roleId?: string; runtime?: HandRuntime };
export type HandTarget = { role: HandRole; runtime: HandRuntime };

type CatalogueRow = { id: string; kind: "builtin" | "note"; aiUse: boolean };

/** The actions to list: the ready-made ones whose skill exists and is on for the AI. */
export function offeredActions(catalogue: readonly CatalogueRow[] | null | undefined): Array<(typeof HAND_ACTIONS)[number]> {
  if (!catalogue) return [];
  const on = new Set(catalogue.filter((s) => s.kind === "builtin" && s.aiUse).map((s) => s.id));
  return HAND_ACTIONS.filter((action) => on.has(action.id));
}

const wayOf = (role: HandRole, kind: HandRuntime) => role.runtimes.find((r) => r.kind === kind);

/** Roles that can take it now and have at least one way to run. */
export const usableRoles = (options: HandOptions | null): HandRole[] =>
  (options?.roles ?? []).filter((role) => role.reason === null && role.runtimes.some((r) => r.available));

/** Role and way for a request: the person's pick where it still works, else the
 *  first usable role on its default way (or its first available one). Null: nobody can take it. */
export function chooseTarget(options: HandOptions | null, pick: HandPick = {}): HandTarget | null {
  const roles = usableRoles(options);
  const role = roles.find((r) => r.actor_id === pick.roleId) ?? roles[0];
  if (!role) return null;
  const wanted = pick.runtime && wayOf(role, pick.runtime)?.available ? pick.runtime : null;
  const fallback = wayOf(role, role.default_runtime)?.available ? role.default_runtime : role.runtimes.find((r) => r.available)!.kind;
  return { role, runtime: wanted ?? fallback };
}

/** How an AI answers, in the words Settings › AI uses (never the protocol's name). */
export const runtimeName = (kind: HandRuntime): string =>
  kind === "api" ? t("API key") : t("Your own AI");

/** The small line that says who answers: the AI's name, plus the way only where the person really has a choice
 *  (a role with more than one way that works): 「小助手 · API 金鑰」. */
export const targetLine = (target: HandTarget): string =>
  target.role.runtimes.filter((r) => r.available).length > 1 ? `${target.role.name} · ${runtimeName(target.runtime)}` : target.role.name;

/** The ways to run `role` that work now (what 「⋯」 lists). */
export const waysOf = (role: HandRole): HandRuntime[] => role.runtimes.filter((r) => r.available).map((r) => r.kind);

/** Whether the entry is offered at all, and if it is shown but stopped, the one-sentence reason. */
export function entryState(input: { canEdit: boolean; online: boolean; options: HandOptions | null }): { shown: boolean; blocked: string | null } {
  if (!input.canEdit) return { shown: false, blocked: null };
  if (!input.online) return { shown: true, blocked: t("Handing to the AI needs a connection.") };
  if (input.options && !input.options.can_hand_off) return { shown: true, blocked: t("You can't edit this note, so the AI can't suggest changes to it.") };
  if (input.options && !chooseTarget(input.options)) return { shown: true, blocked: noRoleText(input.options) };
  return { shown: true, blocked: null };
}

export function noRoleText(options: HandOptions): string {
  if (options.roles.length === 0) return t("No AI is set up yet. Add one in Settings › AI.");
  const first = options.roles[0]!;
  switch (first.reason) {
    case "disabled": return t("This AI is switched off. Turn it on in Settings › AI.");
    case "agent_cannot_write": return t("The AI can't write in this note's space. Use a shared space that lets AI read notes, and add the AI to it.");
    case "not_agents_owner": return t("Only the owner of this AI can hand it work.");
    default: return t("No way to run this AI is available right now. Check Settings › AI.");
  }
}

/** What happened to a request that did not finish, in one plain sentence. */
export function handFailureText(code: string | null): string {
  switch (code) {
    case "selection_changed": return t("The selected text changed while the AI worked, so nothing was suggested.");
    case "selection_not_unique": return t("This text appears more than once in the note. Select a little more so it is clear which one you mean.");
    case "output_too_long": return t("The answer was too long to use. Try a shorter selection.");
    case "empty_reply": return t("The AI sent back nothing. Try again.");
    case "refused": return t("The AI declined this text.");
    case "credential_rejected": return t("The AI's API key was rejected. Check it in Settings › AI.");
    case "cap_reached": return t("This AI has reached its monthly limit.");
    case "api_unreachable": return t("Couldn't reach the AI service. Try again later.");
    case "stopped": return t("Cancelled.");
    default: return failureText(code);
  }
}

export type HandRun = {
  /** Which request this is, so a late answer to an earlier one is dropped. */
  token: number;
  skillName: string;
  line: string;
  runtime: HandRuntime;
  phase: "starting" | "streaming" | "waiting" | "done" | "failed" | "cancelled";
  /** The answer so far (API only): a preview, the suggestion is made from the finished text. */
  text: string;
  sessionId: string | null;
  failCode: string | null;
  /** The pull side's own session, for the status wording a mention's card has. */
  session: AgentSessionBrief | null;
};

/** The status sentence for a request that does not stream: the @ai card's wording. */
export function waitingCard(run: HandRun, now: number): Pick<MentionCard, "tone" | "text"> | null {
  if (!run.session) return null;
  const { tone, text } = sessionCard(run.session, now, null);
  return { tone, text };
}
