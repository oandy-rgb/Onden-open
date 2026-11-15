// Skill notes as skills (docs/architecture/skills-and-presentation.md): a note
// that carries the `skills` module's inside tag (the person's 「當成技能」 switch;
// a tag extending it also counts). Title = name, body = instructions,
// frontmatter `description` / `output` / `applies_to` / `ai` say what it is for,
// where its result goes, which tags' notes offer it and whether the AI may pick
// it by itself.
//
// A skill's body becomes the model's instructions, so the catalogue admits
// only notes that
//   • the actor wrote themselves (a skill is never someone else's words
//     steering your model — shared notes stay data); for an agent token
//     (MCP) "themselves" is the person who issued it — a token with no
//     recorded issuer has no note skills. "Wrote" is twofold: they created the
//     note AND made its last body change (the latest body_hash event). A
//     collaborator who rewrites the body takes the skill out of the
//     catalogue until its author saves it again; it is listed as ignored,
//   • the actor can read (read policy, readableScopeSql),
//   • sit in a space whose external AI switch is on (its text is sent out).
// Every lookup applies all three; knowing an id is never enough.

import { q } from "../../db.js";
import { readableScopeSql } from "../readPolicy.js";
import { filterByCapability } from "../../spine/spaceScope.js";
import { functionIndex } from "../functionRefs.js";
import { workspaceHasModule } from "../workspaceModules.js";
import { fieldList, fieldValue, readFrontmatter, isUuid, type SkillAiMode } from "@onden/markdown";
import { canSeeTag } from "../readPolicy.js";
import type { ActorCtx } from "../../types.js";
import { liveNodeSql, liveTagNodeSql } from "../../spine/nodeSql.js";

/** Where a skill's result is meant to go (the frontend offers it first). */
export type SkillOutput = "note" | "insert" | "slide";

export type NoteSkill = {
  id: string;
  name: string;
  description: string;
  output: SkillOutput;
  /** The note body without its frontmatter. */
  instructions: string;
  /** Tags this skill is for (frontmatter `applies_to`): their notes offer it
   *  directly. Names the actor can't see, or that name no tag, are dropped. */
  appliesTo: string[];
  /** Frontmatter `ai`: `auto` (also when the key is missing) lets the AI pick
   *  the skill itself; `manual` only when the person names it. */
  ai: SkillAiMode;
};

export const isNoteSkillRef = (ref: string) => isUuid(ref);

/** The tags whose members are skills here (none while the module is not imported). */
async function skillTagIds(workspaceId: string): Promise<string[]> {
  if (!(await workspaceHasModule(workspaceId, "skills"))) return [];
  return (await functionIndex(null, workspaceId)).tagsWith("skills");
}

export type SkillRow = { id: string; title: string; markdown: string; description: string | null; output: string | null };

/** Whose own notes count: the person, or for a token its issuer. */
export function skillOwnerId(actor: ActorCtx): string | null {
  return actor.tokenScope ? actor.tokenScope.issuedBy ?? null : actor.id;
}

type LoadedSkills = { skills: NoteSkill[]; ignored: IgnoredNoteSkill[] };

/** A skill note the actor created whose body someone else changed last. */
export type IgnoredNoteSkill = { id: string; name: string };

async function loadSkills(actor: ActorCtx | null, workspaceId: string, onlyId?: string): Promise<LoadedSkills> {
  const author = actor && skillOwnerId(actor);
  if (!actor || !author) return { skills: [], ignored: [] };
  const tags = await skillTagIds(workspaceId);
  if (!tags.length) return { skills: [], ignored: [] };
  const params: unknown[] = [workspaceId, tags, author];
  const readable = readableScopeSql(actor, "n", params);
  let only = "";
  if (onlyId) { params.push(onlyId); only = ` AND n.id = $${params.length}::uuid`; }
  const rows = (await q<SkillRow & { body_by_author: boolean }>(
    `SELECT n.id::text, n.title, n.markdown,
            COALESCE((SELECT e.actor_id = $3 FROM domain_events e
                       WHERE e.workspace_id = n.workspace_id AND e.target_id = n.id::text AND e.payload ? 'body_hash'
                       ORDER BY e.id DESC LIMIT 1), true) AS body_by_author,
            (SELECT a.value FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'description') AS description,
            (SELECT a.value FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'output') AS output
       FROM content_nodes n
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")} AND n.node_type = 'content'
        AND EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag_id = ANY($2::uuid[]))
        AND EXISTS (SELECT 1 FROM domain_events e WHERE e.workspace_id = n.workspace_id
                      AND e.event_type = 'NODE_CREATED' AND e.target_id = n.id::text AND e.actor_id = $3)
        AND ${readable}${only}
      ORDER BY n.title, n.id
      LIMIT 100`,
    params,
  )).rows;
  const allowed = await filterByCapability(workspaceId, "external_ai", new Set(rows.map((r) => r.id)));
  const shown = rows.filter((r) => allowed.has(r.id));
  const ignored = shown.filter((r) => !r.body_by_author).map((r) => ({ id: r.id, name: r.title }));
  const skills = shown.filter((r) => r.body_by_author).map(toSkill);
  const tagIds = await tagIdsByName(actor, workspaceId, skills.flatMap((s) => s.appliesToNames));
  return {
    ignored,
    skills: skills.map(({ appliesToNames, ...skill }) => ({
      ...skill,
      appliesTo: [...new Set(appliesToNames.flatMap((name) => tagIds.get(name.toLowerCase()) ?? []))],
    })),
  };
}

/** Visible tags by lower-cased title (a name may match several tags in
 *  different places; each counts). */
async function tagIdsByName(actor: ActorCtx, workspaceId: string, names: string[]): Promise<Map<string, string[]>> {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()))];
  const out = new Map<string, string[]>();
  if (!wanted.length) return out;
  const rows = (await q<{ id: string; title: string }>(
    `SELECT id::text, title FROM content_nodes
      WHERE workspace_id = $1 AND ${liveTagNodeSql()} AND lower(title) = ANY($2::text[])`,
    [workspaceId, wanted],
  )).rows;
  for (const row of rows) {
    if (!(await canSeeTag(actor, row.id))) continue;
    const key = row.title.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), row.id]);
  }
  return out;
}

/** A skill from its note row: frontmatter first, then the property of the same name. */
export function toSkill(row: SkillRow): Omit<NoteSkill, "appliesTo"> & { appliesToNames: string[] } {
  const front = readFrontmatter(row.markdown);
  const description = (front && fieldValue(front.entries, "description")) || row.description || "";
  const rawOutput = (front && fieldValue(front.entries, "output")) || row.output || "note";
  const output: SkillOutput = rawOutput === "insert" || rawOutput === "slide" ? rawOutput : "note";
  // `applies_to: 論文` or a list; a leading # is allowed.
  const appliesToNames = (front ? fieldList(front.entries, "applies_to") : [])
    .map((name) => name.trim().replace(/^#/, "")).filter(Boolean);
  const ai: SkillAiMode = front && fieldValue(front.entries, "ai") === "manual" ? "manual" : "auto";
  return { id: row.id, name: row.title, description, output, ai, instructions: (front ? front.body : row.markdown).trim(), appliesToNames };
}

/** The actor's skills, by title. */
export async function listNoteSkills(actor: ActorCtx | null, workspaceId: string): Promise<NoteSkill[]> {
  return (await loadSkills(actor, workspaceId)).skills;
}

/** The actor's skill notes that are not offered because someone else changed
 *  the body last (the catalogue says so in a plain sentence). */
export async function listIgnoredNoteSkills(actor: ActorCtx | null, workspaceId: string): Promise<IgnoredNoteSkill[]> {
  return (await loadSkills(actor, workspaceId)).ignored;
}

/** One skill by note id, or null when it isn't one of the actor's skills. */
export async function loadNoteSkill(actor: ActorCtx | null, workspaceId: string, id: string): Promise<NoteSkill | null> {
  if (!isNoteSkillRef(id)) return null;
  return (await loadSkills(actor, workspaceId, id)).skills[0] ?? null;
}
