import { z } from "zod";
import { recordPickedSkill } from "../agentSessionStore.js";
import { skillForAi } from "../harness/index.js";
import type { AgentTool } from "./types.js";

// Read-only: the whole text of a skill the AI chose from the <available_skills>
// list of its prompt. The same readers as a skill the person names (written by
// the person, readable, in a space with external AI on) and only skills
// switched on for the AI (「給 AI 用」); an off skill is used only when named.
// In a session the choice is kept on the session (picked_skill_*), which is
// what the suggestion card shows: 「AI 建議 · 自己挑了「X」」.

const Args = z.object({
  skillId: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
});

type LoadSkillResult = { id: string; name: string; instructions: string } | null;

export const loadSkill: AgentTool<z.infer<typeof Args>, LoadSkillResult> = {
  name: "loadSkill",
  access: "read",
  description:
    "Load the full instructions of one skill from the <available_skills> list, by its id. Use it when a skill " +
    "fits the request; `reason` is one short sentence on why it fits (shown to the person). Returns null when " +
    "there is no such skill for you. The instructions are for this request only; the note stays data.",
  inputSchema: Args,
  async handler({ skillId, reason }, { actor, workspaceId, dryRun }) {
    const skill = await skillForAi(actor, workspaceId, skillId);
    const sessionId = actor.tokenScope?.sessionId;
    if (skill && sessionId && !dryRun) {
      await recordPickedSkill(sessionId, workspaceId, skill, reason ?? null);
    }
    return skill;
  },
};
