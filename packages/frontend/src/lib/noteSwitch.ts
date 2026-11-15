// A module's note switch (FrontendModule.noteSwitch, 「當成技能」) for one note,
// outside React: whether it is on, and turning it on or off. The info panel's
// row (hooks/useNoteSwitch) and the note's ⋯ / ⌘K command that turns it on
// (modules/index NOTE_COMMANDS) both go through here.

import type { ContentNode, Tag } from "./api";
import { addToast } from "./appStore";
import { tagWriter, writeErrors } from "./data";
import { t } from "./i18n";
import { ensureModuleTagId } from "./ensureModuleTag";
import { nodeHasTag } from "./nodeTags";
import { moduleTagOf } from "./tagModules";

/** Whether `node` carries the module's inside tag. */
export function noteSwitchOn(node: ContentNode, moduleId: string, tags: readonly Tag[]): boolean {
  const tag = moduleTagOf(tags, moduleId);
  return !!tag && nodeHasTag(node, tag.id);
}

/** Add or remove the module's inside tag with the tag writer (saved or queued
 *  like any tag change; nothing here shows the tag). True once the server
 *  accepted the change or it is durably queued; a refusal was reported by the writer. */
export async function setNoteSwitch(node: ContentNode, moduleId: string, next: boolean, tags: readonly Tag[]): Promise<boolean> {
  try {
    const tagId = next ? await ensureModuleTagId(moduleId) : moduleTagOf(tags, moduleId)?.id ?? null;
    if (!tagId) {
      if (next) addToast(t("Couldn't turn this on. Check Settings › Features."), "error");
      return false;
    }
    const result = next ? await tagWriter.apply(node.id, tagId) : await tagWriter.remove(node.id, tagId);
    if (result.status === "queued") addToast(writeErrors.queuedMessage(), "info");
    return true;
  } catch { return false; /* The writer already reported it. */ }
}
