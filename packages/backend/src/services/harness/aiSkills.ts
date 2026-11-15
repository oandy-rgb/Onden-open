// Skills the AI may pick by itself (docs/architecture/harness.md, 「給 AI 用」).
// A skill carries one switch: a skill note's frontmatter `ai` (missing = on),
// a built-in skill's account preference `aiSkillsOff`. On, the AI is shown the
// skill's name and when to use it (`availableSkills`, rendered into a mention
// session's prompt) and loads the whole text only when it decides to use it
// (`skillForAi`, the loadSkill tool). Off, the skill is used only when the
// person names it (`@ai /[[技能]]`, MCP prompts/get). Both lookups go through
// the same readers as a named skill (noteSkills.ts: written by the actor,
// readable, in a space with external AI on), so the AI never sees more than a
// named skill would give it.
import { cutToUnits } from "@onden/markdown";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readPrefOf } from "../actorPrefs.js";
import { BUILTIN_SKILLS, builtinSkill, type BuiltinSkill } from "./builtinSkills.js";
import { isNoteSkillRef, listNoteSkills, loadNoteSkill, skillOwnerId } from "./noteSkills.js";

/** One line of the AI's list: enough to decide, nothing to follow. */
export type AvailableSkill = { id: string; name: string; description: string; fits: boolean };

export const AVAILABLE_SKILLS_MAX = 20;
export const SKILL_NAME_MAX = 60;
export const SKILL_WHEN_MAX = 200;

/** The built-in skills the person turned off for the AI's own picking. */
export async function builtinSkillsOffForAi(actor: ActorCtx | null): Promise<Set<string>> {
  const owner = actor && skillOwnerId(actor);
  if (!owner) return new Set();
  const stored = await readPrefOf(owner, "aiSkillsOff");
  return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
}

/** A built-in skill the AI can use on a note: not the runner's own mention
 *  prompt, and one that works on text or notes. */
const usableOnNote = (s: BuiltinSkill) => !s.hidden && s.scopes.some((kind) => kind === "nodes" || kind === "text");

/** The skills offered to the AI for a note with these tags: those switched on,
 *  the ones for this note's tags first (`fits`), then by name; at most
 *  AVAILABLE_SKILLS_MAX. */
export async function availableSkills(actor: ActorCtx | null, workspaceId: string, noteTagIds: readonly string[]): Promise<AvailableSkill[]> {
  const tags = new Set(noteTagIds);
  const notes = (await listNoteSkills(actor, workspaceId)).filter((s) => s.ai === "auto").map((s): AvailableSkill => ({
    id: s.id, name: s.name, description: s.description, fits: s.appliesTo.some((id) => tags.has(id)),
  }));
  const off = await builtinSkillsOffForAi(actor);
  const builtins = BUILTIN_SKILLS.filter((s) => usableOnNote(s) && !off.has(s.id))
    .map((s): AvailableSkill => ({ id: s.id, name: s.name, description: s.description, fits: false }));
  return [...notes, ...builtins]
    .sort((a, b) => Number(b.fits) - Number(a.fits))
    .filter((_, i) => i < AVAILABLE_SKILLS_MAX)
    .map((s) => ({ ...s, name: cutToUnits(s.name, SKILL_NAME_MAX), description: cutToUnits(s.description.replace(/\s+/g, " "), SKILL_WHEN_MAX) }));
}

/** A skill the AI chose, whole: null when there is no such skill for the
 *  actor, or it is switched off (an off skill is only used when named). */
export async function skillForAi(actor: ActorCtx | null, workspaceId: string, id: string): Promise<{ id: string; name: string; instructions: string } | null> {
  const builtin = builtinSkill(id);
  if (builtin) {
    if (!usableOnNote(builtin) || (await builtinSkillsOffForAi(actor)).has(id)) return null;
    return { id: builtin.id, name: builtin.name, instructions: builtin.system() };
  }
  if (!isNoteSkillRef(id)) return null;
  const note = await loadNoteSkill(actor, workspaceId, id);
  return note && note.ai === "auto" ? { id: note.id, name: note.name, instructions: note.instructions } : null;
}

/** The tags a note carries directly (what a skill's `applies_to` is matched with). */
export async function noteTagIds(nodeId: string): Promise<string[]> {
  return (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [nodeId])).rows.map((r) => r.tag_id);
}
