// The owner's AI settings page (設定 › AI): what the page and the server say to each other.
// Pure types: the app imports them with `import type`, so nothing here may run.
// A connection (an API key) and an AI (the role that uses it) are separate things: the key lives in
// `ai_credentials`, the AI points at it with `api_credential_id`.

/** The monthly limit an API-run AI is given: a number of tokens, or none. */
export type AiMonthlyCap = { kind: "unlimited" } | { kind: "capped"; tokens: number };

/** One model a connection reports. The list is whatever the service itself says; Onden keeps none. */
export type AiModelChoice = { id: string; display_name: string; lifecycle: "active" | "deprecated" | "retired"; web_search: boolean };

/** POST /api/ai/credentials/test: ask the service with this key, saving nothing. */
export type AiCredentialTestRequest = { base_url: string; api_key: string; protocol?: string };
export type AiCredentialTestResult = { ok: true; protocol: string; models: AiModelChoice[] };

/** What a new AI runs on. */
export type AiConnectionInput =
  /** A key already saved. */
  | { kind: "api"; credential_id: string; model: string; cap: AiMonthlyCap }
  /** A key typed now: it is kept together with the AI, or not at all. */
  | {
      kind: "api_new"; label: string; api_key: string; base_url: string; protocol?: string;
      input_price_per_m?: number | null; output_price_per_m?: number | null; model: string; cap: AiMonthlyCap;
    }
  /** The owner's own AI connects with a connection code (shown once in the reply). */
  | { kind: "mcp"; key_name?: string };

/** POST /api/ai/roles: make an AI and everything it needs in one step (nothing is left half done).
 *  It starts suggest-only, answers to `@handle` (the first free one starting with `ai` when none is given),
 *  and stands in each shared space exactly where that space already lets AI read: "edit" there (owner 2026-11-11: it can run at once, and it is
 *  suggest-only, so every change still waits for the owner), not in the others.
 *  It never turns a space's "AI can read" switch on. */
export type SetUpAiRequest = { name: string; handle?: string; connection: AiConnectionInput };
export type SetUpAiResult = {
  actor_id: string; handle: string;
  /** The key that was saved together with the AI (api_new). */
  credential_id: string | null;
  /** The connection code, once (mcp). */
  token: string | null;
  /** The shared spaces it was put in (where AI reading was already on). */
  joined_space_ids: string[];
};

/** GET /api/ai/roles: the `api` part of one AI. `credential_id` is the live key it uses, null when none
 *  (never chosen, or the key was deleted). Label and last four characters only; the key itself never leaves the server. */
export type AiRoleApiSettings = {
  model: string | null; model_retired: boolean; small_actions_only: boolean; web_search: boolean;
  credential_id: string | null; key_label: string | null; key_last4: string | null;
  cap: "capped" | "unlimited" | null; monthly_cap_tokens: number | null; used_this_month_tokens: number;
};

/** Where an agent session is: the first three are open, the last three ended. */
export type SessionStatus = "queued" | "delivered" | "running" | "completed" | "failed" | "cancelled";

export type SuggestionItemKind = "replace" | "insert" | "delete" | "title" | "comment";
export type SuggestionItemStatus = "pending" | "accepted" | "rejected" | "stale" | "void" | "replaced";

/** One place an AI proposed to change, as GET /api/ai-suggestions lists it. */
export type SuggestionItem = {
  id: string;
  seq: number;
  kind: SuggestionItemKind;
  base_text: string;
  base_occurrence: number;
  new_text: string | null;
  status: SuggestionItemStatus;
  /** Where the place is in the note as it is now (the paragraph `base_text` became, which an accepted place may have
   *  rewritten); null: it cannot be found any more. Absent for an item that is not about a paragraph. The client draws
   *  from this, it does not search `base_text` itself. */
  place?: { text: string; occurrence: number } | null;
  /** A replace whose words are the same: only the blank space around the paragraph (`spacing`), or only its
   *  indentation or line ends (`indent`), changes. */
  change?: "spacing" | "indent" | null;
};

/** The skill behind a set, for its header: named by the person (`picked` false) or chosen by the AI itself with its
 *  one-sentence reason. Only the person who asked sees it (the skill is theirs). */
export type SuggestionSkill = { name: string; picked: boolean; reason: string | null };

/** One set of places an AI proposed for a note. */
export type NoteSuggestion = {
  id: string;
  agent_actor_id: string;
  agent_name: string;
  session_id: string | null;
  created_at: string;
  /** Not decided for 30 days: shown as older, never removed or rejected for the person. */
  older: boolean;
  skill: SuggestionSkill | null;
  items: SuggestionItem[];
};

/** A note the AI read for an answer, with the paragraph it linked, if any. */
export type ChatSource = { node_id: string; title: string; block_id: string | null };

/** One question to the AI in a note's chat panel and where its answer stands (GET /api/ai/chat). */
export type ChatTurn = {
  session_id: string;
  text: string;
  status: SessionStatus;
  fail_code: string | null;
  reply: string | null;
  /** How the AI is run: "api" or "mcp" (the app reads an unknown newer kind as a string). */
  runtime: string;
  agent_name: string | null;
  created_at: string;
  scope: { notes: Array<{ id: string; title: string }>; tags: Array<{ id: string; name: string }> };
  /** Notes the AI read for this answer (checked against its log), each with the paragraph it linked, if any. */
  sources: ChatSource[];
  suggestions: { pending: number; accepted: number; rejected: number };
  /** The pending places (suggestion and item), to accept or turn down in one go through the suggestions routes. */
  pending: Array<{ suggestion_id: string; item_id: string }>;
};

type SkillScopeKind = "search" | "text" | "nodes" | "tag" | "board";

/** A skill as GET /api/skills lists it: built-in, or one of the actor's skill notes (`id` is then the note id). */
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  kind: "builtin" | "note";
  scopes: ReadonlyArray<SkillScopeKind>;
  /** Where the result is meant to go; the person still confirms any write. */
  output: "note" | "insert" | "slide";
  /** Tag ids whose notes offer this skill directly (a note skill's frontmatter `applies_to`); empty for the rest. */
  appliesTo: string[];
  /** The 「給 AI 用」 switch: the AI may pick this skill itself. Off, it is used only when named. */
  aiUse: boolean;
};
