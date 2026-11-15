// Readable names for actor types, shared by the event log, side drawer and
// trash views. Event codes have theirs in lib/eventKinds.ts.

import { t } from "../lib/i18n";

const ACTOR_TYPE_LABELS: Record<string, string> = {
  user: "User",
  human: "User",
  ai_agent: "AI",
  agent: "AI",
  system: "System (automatic)",
};

/** Readable, translated name for an actor type (user / ai_agent / system). */
export function actorTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  const label = ACTOR_TYPE_LABELS[type];
  return label ? t(label) : type;
}
