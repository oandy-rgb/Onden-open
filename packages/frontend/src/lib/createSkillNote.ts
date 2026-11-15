// Making a skill without hand-writing frontmatter: one note with 「當成技能」
// on (the module's inside tag; nothing shows it as a tag) whose
// settings are stored the way hand-written skill notes store them
// (@onden/markdown skillNoteMarkdown; the backend's noteSkills.ts reads them).
// 「存成技能」, 「匯入 SKILL.md」 and a future 「+ 新技能」 all create through here.
//
//   const skills = useCreateSkillNote();
//   const node = await skills.create({ title: "Reading notes", instructions: "…", output: "note" });
//
// Resolves the created note, or null when nothing was created: the writer
// refused (it has reported why). Skills is a built-in function that is on by
// default; if the owner turned it off, making a skill turns it back on.
// A resolved note is accepted by the server or durably queued, as every
// noteWriter.create; it lands where new notes normally land (the creator's
// own space unless the server says otherwise, or under `parentId`), and a skill runs only from a
// space that lets AI read notes.
import { randomUUID } from "./uuid";
import { skillNoteMarkdown, type SkillNoteInput, cutToUnits } from "@onden/markdown";
import type { ContentNode } from "./api";
import { addToast } from "./appStore";
import { noteWriter } from "./data";
import { t } from "./i18n";
import { ensureModuleTagId } from "./ensureModuleTag";
import { SKILLS_MODULE as SKILLS } from "../modules";
import { displayTitle } from "./noteLabel";

export type { SkillNoteInput };
export type CreateSkillInput = Omit<SkillNoteInput, "exampleHeading">;

/** Title of the example section in the body. */
export const exampleHeading = () => t("Example");

/** Create the skill note; see the file comment. */
export async function createSkillNote(
  input: CreateSkillInput,
  { openNode, parentId }: { openNode?: (id: string) => void; parentId?: string | null } = {},
): Promise<ContentNode | null> {
  const title = displayTitle(cutToUnits(input.title.trim(), 200));
  const markdown = skillNoteMarkdown({ ...input, exampleHeading: exampleHeading() });
  // One id per call, so a retry inside this call can't create it twice.
  const id = randomUUID();
  let created: ContentNode | null = null;

  const write = async (tagId: string | null): Promise<boolean> => {
    if (!tagId) { addToast(t("Skills aren't set up yet. Check Settings › Features."), "error"); return false; }
    try {
      created = (await noteWriter.create({ id, title, markdown, tagIds: [tagId], ...(parentId ? { parent_id: parentId } : {}) })).node;
      return true;
    } catch { return false; } // the note writer has reported why
  };

  // The skills tag exists once the module was on; an owner who turned the
  // module off, or a workspace missing the tag, asks the server to (re)make it.
  await write(await ensureModuleTagId(SKILLS));
  const node = created as ContentNode | null;
  if (node) {
    addToast(t("Created the skill “{title}”", { title }), "success");
    openNode?.(node.id);
  }
  return node;
}

/** `createSkillNote`, as the skill dialogs use it. */
export function useCreateSkillNote(openNode?: (id: string) => void, parentId?: string | null) {
  return { create: (input: CreateSkillInput) => createSkillNote(input, { openNode, parentId }) };
}
