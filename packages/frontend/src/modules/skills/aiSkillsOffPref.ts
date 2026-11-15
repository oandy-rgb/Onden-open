// The built-in skills this account turned off for the AI's own picking (「給 AI 用」
// on the skills page), kept per account (lib/accountPrefStore, pref key
// "aiSkillsOff"). A skill note keeps its own switch in the note; a built-in
// one has no note, so its switch is here. A missing list means all are on.
import { createAccountPref } from "../../lib/accountPrefStore";
import { PREFS } from "../../lib/prefs";

export type AiSkillsOff = readonly string[];
const MAX_IDS = 100;

export function parseAiSkillsOff(value: unknown): AiSkillsOff | null {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
  return [...new Set(value as string[])].filter((_, i) => i < MAX_IDS);
}

export const aiSkillsOffPref = createAccountPref<AiSkillsOff>({
  serverKey: "aiSkillsOff",
  follows: "account", // which AI skills the person turned off: their choice, not the screen's
  copy: PREFS.aiSkillsOff,
  parse: parseAiSkillsOff,
});

/** The list with built-in skill `id` switched on or off for the AI. */
export function withBuiltinAi(off: AiSkillsOff | null, id: string, on: boolean): AiSkillsOff {
  const rest = (off ?? []).filter((other) => other !== id);
  return on ? rest : [...rest, id];
}
