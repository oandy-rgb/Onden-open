import { confirmDialog } from "./ConfirmDialog";
import type { FieldUsage } from "../hooks/useFieldUsage";
import { t } from "../lib/i18n";

/** Whether the field `key` (shown as `name`) may be removed: true at once
 *  when it has no values or the host tracks no usage (`usage` undefined);
 *  otherwise the user's answer to one plain-language pause. The values are
 *  not destroyed — they stay as plain properties. */
export async function confirmFieldRemoval(name: string, key: string, usage: FieldUsage | undefined): Promise<boolean> {
  const used = usage === null ? null : (usage?.[key] ?? 0);
  const question = used === null
    ? t("Could not check whether \"{name}\" is in use — it may have values on some notes. Remove the field anyway? Any values stay as plain properties.", { name })
    : used > 0
      ? t("\"{name}\" has values on {n} note(s). Remove the field? The values stay as plain properties.", { name, n: used })
      : null;
  return question === null || confirmDialog(question, { confirmLabel: t("Remove field"), danger: true });
}
