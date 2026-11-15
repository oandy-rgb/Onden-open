import { t } from "./i18n";

// How a person reads an AI actor, wherever one is named: "AI" (the one English
// word; the zh-TW table says whose AI it is). A named agent shows its own name.

/** The AI as a bare label, for an unnamed or several agents. */
export const aiLabel = (): string => t("AI");

/** The agent's own name, or the bare AI label when it has none. */
export const agentLabel = (name?: string | null): string => name || aiLabel();

/** A space member: a person by name, an AI role with the AI marked after its name. */
export function memberLabel(member: { name: string; type: string }): string {
  return member.type === "agent" ? t("{name} (AI)", { name: member.name }) : member.name;
}
