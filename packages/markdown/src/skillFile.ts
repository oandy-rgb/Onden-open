// SKILL.md (the Agent Skills file: YAML frontmatter + instructions) and the
// note an Onden skill is stored as (docs/architecture/skills-and-presentation.md):
// title = name, body = instructions, frontmatter `description` / `output` /
// `applies_to` = settings. One codec for both directions, so what the
// backend exports as SKILL.md (services/harness) and what the frontend imports
// agree on every key.
//
// Onden runs no third-party code: an imported SKILL.md contributes its text
// only. `bundledFiles` tells the caller the body points at scripts or extra
// files that were NOT brought along, so it can say so.

import { cutToUnits } from "./graphemes.js";
import { entryFor, entryValue, fieldList, fieldValue, readFrontmatter, writeFrontmatter, type FrontmatterEntry } from "./frontmatter.js";

export const SKILL_OUTPUTS = ["note", "insert", "slide"] as const;

/** Whether the AI may pick a skill by itself (frontmatter `ai`): `auto` (also
 *  when the key is missing) offers it in the AI's list; `manual` only when the
 *  person names it. */
export const SKILL_AI_MODES = ["auto", "manual"] as const;
export type SkillAiMode = (typeof SKILL_AI_MODES)[number];

/** The settings of an Onden skill note, besides its title and instructions. */
export type SkillSettings = {
  description?: string;
  output?: (typeof SKILL_OUTPUTS)[number];
  /** Names of the tags whose notes offer the skill as a header button. */
  appliesTo?: readonly string[];
  /** Written only when `manual`: a missing key already means `auto`. */
  ai?: SkillAiMode;
};

export type SkillNoteInput = SkillSettings & {
  title: string;
  instructions: string;
  /** A good result, kept at the end of the body under `exampleHeading`. */
  example?: string;
  /** Heading of the example section (the caller's language); default "Example". */
  exampleHeading?: string;
};

/** The markdown of a skill note: settings as frontmatter, then the
 *  instructions and, when given, an example section. Whole-body: the harness
 *  sends everything after the frontmatter to the model. */
export function skillNoteMarkdown(input: Omit<SkillNoteInput, "title">): string {
  const entries: FrontmatterEntry[] = [];
  const description = input.description?.replace(/\s+/g, " ").trim();
  if (description) entries.push(entryFor("description", description));
  if (input.output && (SKILL_OUTPUTS as readonly string[]).includes(input.output)) entries.push(entryFor("output", input.output));
  const appliesTo = (input.appliesTo ?? []).map((n) => n.trim().replace(/^#/, "")).filter(Boolean);
  if (appliesTo.length) entries.push(entryFor("applies_to", appliesTo));
  if (input.ai === "manual") entries.push(entryFor("ai", "manual"));
  let body = input.instructions.trim();
  const example = input.example?.trim();
  if (example) body += `\n\n## ${input.exampleHeading ?? "Example"}\n\n${example}`;
  const front = writeFrontmatter(entries);
  return front ? `${front}\n${body}\n` : `${body}\n`;
}

/** The settings a skill note's frontmatter holds (what the AI list and the
 *  info panel read). A missing or unknown `ai` is `auto`; `appliesTo` has no
 *  leading `#`. */
export function readSkillSettings(markdown: string): { description: string; output: (typeof SKILL_OUTPUTS)[number]; appliesTo: string[]; ai: SkillAiMode } {
  const entries = readFrontmatter(markdown)?.entries ?? [];
  const output = fieldValue(entries, "output");
  const ai = fieldValue(entries, "ai");
  return {
    description: fieldValue(entries, "description") ?? "",
    output: (SKILL_OUTPUTS as readonly string[]).includes(output ?? "") ? output as (typeof SKILL_OUTPUTS)[number] : "note",
    appliesTo: fieldList(entries, "applies_to").map((n) => n.trim().replace(/^#/, "")).filter(Boolean),
    ai: ai === "manual" ? "manual" : "auto",
  };
}

/** `markdown` with some skill settings changed, every other frontmatter line
 *  and the body untouched. An empty description, no tags or `ai: auto` removes
 *  the key (the default is written as nothing). */
export function withSkillSettings(markdown: string, change: { description?: string; appliesTo?: readonly string[]; ai?: SkillAiMode }): string {
  const front = readFrontmatter(markdown);
  let entries = front?.entries ?? [];
  const replace = (key: string, next: FrontmatterEntry | null) => {
    const at = entries.findIndex((e) => e.key === key);
    const rest = entries.filter((e) => e.key !== key);
    entries = next ? [...rest.slice(0, at < 0 ? rest.length : at), next, ...rest.slice(at < 0 ? rest.length : at)] : rest;
  };
  if (change.description !== undefined) {
    const description = change.description.replace(/\s+/g, " ").trim();
    replace("description", description ? entryFor("description", description) : null);
  }
  if (change.appliesTo !== undefined) {
    const names = change.appliesTo.map((n) => n.trim().replace(/^#/, "")).filter(Boolean);
    replace("applies_to", names.length ? entryFor("applies_to", names) : null);
  }
  if (change.ai !== undefined) replace("ai", change.ai === "manual" ? entryFor("ai", "manual") : null);
  const body = front ? front.body : markdown;
  const written = writeFrontmatter(entries);
  // A block that was already there keeps the blank line it had; a new one gets one.
  return written ? `${written}${front ? "" : "\n"}${body}` : body.replace(/^\n+/, "");
}

/** A standard SKILL.md (the Agent Skills format) to export: `name` and
 *  `description` in frontmatter, then the instructions. The inverse of
 *  parseSkillMd. */
export function skillMdMarkdown(skill: { name: string; description: string; instructions: string; ai?: SkillAiMode }): string {
  const entries = [entryFor("name", skill.name), entryFor("description", skill.description)];
  if (skill.ai === "manual") entries.push(entryFor("ai", "manual"));
  const front = writeFrontmatter(entries);
  return `${front}\n${skill.instructions}\n`;
}

export type ParsedSkillMd = SkillSettings & {
  title: string;
  instructions: string;
  /** Frontmatter keys Onden does not understand (left out of the note). */
  ignoredKeys: string[];
  /** The body mentions scripts or extra files, which are not imported. */
  bundledFiles: boolean;
};

/** Why a SKILL.md could not be read. */
export class SkillMdError extends Error {
  readonly code = "empty";
  constructor() { super("The SKILL.md has no instructions."); this.name = "SkillMdError"; }
}

// `name: my-skill` becomes the title "my skill".
const titleFromName = (name: string) => name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** A YAML block scalar (`>` folded, `|` literal) or a plain multi-line value,
 *  which entryValue does not model. */
function blockText(entry: FrontmatterEntry): string | undefined {
  const rest = (entry.lines[0]!.slice((entry.key ?? "").length + 1)).trim();
  const lines = entry.lines.slice(1).map((l) => l.trim());
  if (!lines.length && !rest) return undefined;
  if (/^\|/.test(rest)) return lines.join("\n").trim();
  const head = /^[>|]/.test(rest) ? [] : [rest];
  return [...head, ...lines].join(" ").replace(/\s+/g, " ").trim();
}

function scalarOf(entry: FrontmatterEntry): string | undefined {
  const v = entryValue(entry);
  if (v !== undefined) return (Array.isArray(v) ? v.join(", ") : v).trim();
  return blockText(entry);
}

function listOf(entry: FrontmatterEntry): string[] {
  const v = entryValue(entry);
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  return (v ?? blockText(entry) ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

const BUNDLED = [
  // scripts/run.py, references/guide.md, assets/x.png, ${…_SKILL_DIR}/…
  /(?:^|[\s`("'\[])(?:\.\/)?(?:scripts|references|assets|resources|templates|bin)\/[\w.\-/]+/m,
  /\$\{?[A-Z]+_SKILL_DIR\}?/,
  // A runnable file named in the text: run.py, setup.sh, tool.js …
  /(?:^|[\s`("'\/])[\w\-]+\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|exe)\b/m,
  // A link to a sibling file: [guide](REFERENCE.md), not a web link or an anchor.
  /\]\((?!https?:|mailto:|#|\/)[^)\s]+\.[A-Za-z0-9]{1,5}\)/,
];
/** Whether text points at scripts or files that ship beside a SKILL.md. */
export function mentionsBundledFiles(text: string): boolean {
  return BUNDLED.some((re) => re.test(text)); // code blocks count: that is where commands live
}

/** Read a SKILL.md (or any Markdown with a frontmatter block) into the parts
 *  of an Onden skill. CRLF is fine; text without frontmatter uses its first
 *  `# heading` (or first line) as the title. Throws SkillMdError when there
 *  are no instructions. */
export function parseSkillMd(source: string): ParsedSkillMd {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const front = readFrontmatter(text);
  let body = (front ? front.body : text).trim();
  const out: ParsedSkillMd = { title: "", instructions: "", ignoredKeys: [], bundledFiles: false };
  for (const entry of front?.entries ?? []) {
    if (!entry.key) continue;
    switch (entry.key.toLowerCase()) {
      case "name": { const v = scalarOf(entry); if (v) out.title = titleFromName(v); break; }
      case "description": { const v = scalarOf(entry); if (v) out.description = v; break; }
      case "output": {
        const v = scalarOf(entry)?.toLowerCase();
        if (v && (SKILL_OUTPUTS as readonly string[]).includes(v)) out.output = v as (typeof SKILL_OUTPUTS)[number];
        else out.ignoredKeys.push(entry.key);
        break;
      }
      case "applies_to": { const v = listOf(entry); if (v.length) out.appliesTo = v; break; }
      case "ai": {
        const v = scalarOf(entry)?.toLowerCase();
        if (v && (SKILL_AI_MODES as readonly string[]).includes(v)) out.ai = v as SkillAiMode;
        else out.ignoredKeys.push(entry.key);
        break;
      }
      default: out.ignoredKeys.push(entry.key);
    }
  }
  if (!out.title) {
    const heading = body.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/);
    if (heading) { out.title = heading[1]!.trim(); body = body.slice(heading[0].length).trim(); }
    else out.title = cutToUnits(body.split("\n", 1)[0]!.replace(/^#+\s*/, "").trim(), 60);
  }
  if (!body) throw new SkillMdError();
  out.instructions = body;
  out.bundledFiles = mentionsBundledFiles(body);
  return out;
}
