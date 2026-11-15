// Changing a skill note's settings (frontmatter `description`, `applies_to`,
// `ai`) from anywhere in the app — the info panel, the skills page, a tag
// page. All of them edit the note's own text through drafts.editText (into the
// open editor's draft, or saved directly like any edit), so a setting has one
// copy: the note.
import { nodeNeedsBody } from "../../lib/api";
import { addToast, getNode } from "../../lib/appStore";
import { dataSync, drafts } from "../../lib/data";
import { t } from "../../lib/i18n";
import { withSkillSettings, type SkillAiMode } from "@onden/markdown";

export type SkillChange = { description?: string; appliesTo?: readonly string[]; ai?: SkillAiMode };

/** Change skill note `noteId`'s settings; `change` can depend on the text it
 *  is applied to. Resolves true once the change is in the note's draft, accepted
 *  or durably queued; false when it was refused (the writer said why) or the
 *  note's text is not here. */
export async function changeSkill(noteId: string, change: SkillChange | ((markdown: string) => SkillChange)): Promise<boolean> {
  const find = () => getNode(noteId);
  try {
    // A big workspace keeps only opened bodies in memory.
    if (nodeNeedsBody(find())) await dataSync.hydrateNode(noteId);
    const result = await drafts.editText(noteId, (body) => withSkillSettings(body, typeof change === "function" ? change(body) : change));
    if (result === "missing") addToast(t("Couldn't change this skill. Open the note and try again."), "error");
    return result === "applied";
  } catch { return false; /* The writer already reported it. */ }
}
