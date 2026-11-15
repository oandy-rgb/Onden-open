import { Merge } from "lucide-react";
import { useT , tn } from "../../lib/i18n";
import { Modal, Pressable } from "../ui";
import "../ConfirmDialog.css";
import type { TagMerge } from "./useTagMerge";
import { Select } from "../ui";

/** The merge picker and, once a target is chosen, its preview and confirm.
 *  `pathOf` labels candidates with their path (two tags can share a name). */
export default function MergePanel({ tagName, merge, pathOf }: {
  tagName: string; merge: TagMerge; pathOf: (id: string, name: string) => string;
}) {
  const t = useT();
  const { preview: mergePreview } = merge;
  if (!merge.open) return null;
  return (
    <div className="schema-lens-merge-panel" role="region" aria-label={t("Merge into another tag")}>
      <label className="schema-lens-merge-pick">
        {t("Merge #{name} into", { name: tagName })}
        <Select
          className="schema-lens-merge-select"
          value={merge.targetId}
          onChange={(e) => void merge.pickTarget(e.target.value)}
        >
          <option value="">{t("choose a tag…")}</option>
          {merge.candidates.map((c) => (
            <option key={c.id} value={c.id}>#{pathOf(c.id, c.name)}</option>
          ))}
        </Select>
      </label>
      {mergePreview && (
        <Modal label={t("Merge #{name} into", { name: tagName })} role="alertdialog" className="confirm-dialog-backdrop" busy={merge.merging} onClose={merge.close}>
        <div className="confirm-dialog">
          <p className="schema-lens-delete-headline">
            {t("Merging #{source} into #{target}:", { source: mergePreview.source.name, target: mergePreview.target.name })}
          </p>
          <ul className="schema-lens-delete-list">
            <li>{tn("1 note will also get #{target}", "{n} notes will also get #{target}", mergePreview.members_gaining_target, { target: mergePreview.target.name })}</li>
            {mergePreview.already_in_target > 0 && (
              <li>{tn("1 note already has #{target} — nothing changes for them", "{n} notes already have #{target} — nothing changes for them", mergePreview.already_in_target, { target: mergePreview.target.name })}</li>
            )}
            {mergePreview.fields_only_in_source.length > 0 && (
              <li>{t("values for {fields} stay on the notes as plain properties", {
                fields: mergePreview.fields_only_in_source.map((f) => `"${f}"`).join(", "),
              })}</li>
            )}
            {mergePreview.functions_not_carried > 0 && (
              <li>{tn("#{source}'s 1 function is not carried over to #{target}", "#{source}'s {n} functions are not carried over to #{target}", mergePreview.functions_not_carried, { source: mergePreview.source.name, target: mergePreview.target.name })}</li>
            )}
            {mergePreview.views_not_carried > 0 && (
              <li>{tn("#{source}'s 1 view is not carried over to #{target}", "#{source}'s {n} views are not carried over to #{target}", mergePreview.views_not_carried, { source: mergePreview.source.name, target: mergePreview.target.name })}</li>
            )}
          </ul>
          <p className="schema-lens-delete-note">
            {t("#{name} is deleted — restore it from History any time to undo the merge.", { name: mergePreview.source.name })}
          </p>
          <div className="schema-lens-delete-actions">
            <Pressable className="schema-lens-action" onClick={merge.close}>{t("Cancel")}</Pressable>
            <Pressable className="schema-lens-action schema-lens-merge-go" disabled={merge.merging} onClick={() => void merge.confirm()}>
              <Merge size={13} /> {t("Merge into #{target}", { target: mergePreview.target.name })}
            </Pressable>
          </div>
        </div>
        </Modal>
      )}
    </div>
  );
}
