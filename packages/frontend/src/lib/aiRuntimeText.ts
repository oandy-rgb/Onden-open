// The words for an AI role's ways of running (GET /api/ai/roles, panel-chat roles): its name, why it cannot be
// used, how it is doing. The server computes every "available" from facts; this file only words them. Used by
// the owner's settings (settings/spacesAndMembers) and the info panel's 「AI」 tab.
import { useT } from "./i18n";
import { agoLabel } from "./timeLabels";

// The server's runtime kinds: api and mcp.
export type RuntimeKind = "api" | "mcp" | (string & {});
export type RuntimeEntry = { kind: RuntimeKind; available: boolean; unavailable_reason: string | null; last_seen_at: string | null };

/** The words for a way of running: its name, why it cannot be used, and how it is doing. */
export function useRuntimeText() {
  const t = useT();
  const label = (kind: RuntimeKind) =>
    kind === "api" ? t("API (runs on your server with your key)") : t("Your own AI (MCP)");
  const reason = (code: string | null) => ({
    no_model: t("Choose a model."), model_retired: t("The model was retired. Choose another."), cap_unanswered: t("Choose a monthly limit."),
    cap_reached: t("This month's limit is used up."),
    external_ai_off: t("No space lets this AI read and edit with AI allowed."), agent_disabled: t("Paused."), no_token: t("No key for your own AI yet."),
    no_key: t("No API key."), key_unchosen: t("Choose an API key."),
  } as Record<string, string>)[code ?? ""] ?? t("Not available right now.");
  /** One sentence on how a way of running is doing. */
  const status = (entry: RuntimeEntry) => {
    const seen = entry.last_seen_at ? agoLabel(entry.last_seen_at) : "";
    if (entry.kind === "mcp") {
      if (!entry.available) return reason(entry.unavailable_reason);
      return seen ? t("Ready. Your AI last called it {when}.", { when: seen }) : t("Ready. Nothing has called it yet.");
    }
    return entry.available ? t("Ready.") : reason(entry.unavailable_reason);
  };
  return { label, reason, status };
}
