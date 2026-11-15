import type { Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { Pressable, Select } from "../ui";
import type { TagTreeModel } from "./tagTreeModel";

/** 「移到另一個標籤底下…」: pick the tag's parent (another tag; notes are never
 *  offered — the tag tree and the note tree are separate). Choosing saves at
 *  once, then the panel closes. */
export default function MoveUnderPanel({ tag, tree, disabled, onMove, onClose }: {
  tag: Tag; tree: Pick<TagTreeModel, "parentTag" | "parentChoices" | "pathOf">; disabled: boolean;
  onMove: (parentId: string | null) => Promise<void>; onClose: () => void;
}) {
  const t = useT();
  const { parentTag, parentChoices, pathOf } = tree;
  return (
    <div className="schema-lens-merge-panel" role="region" aria-label={t("Move under another tag")}>
      <label className="schema-lens-merge-pick">
        {t("Move #{name} under", { name: tag.name })}
        <Select aria-label={t("Parent tag")} className="schema-lens-merge-select" value={tag.parent_id ?? ""} disabled={disabled}
          onChange={(e) => void onMove(e.target.value || null).then(onClose)}>
          <option value="">{t("None (top level)")}</option>
          {/* A parent not offered (a note — old data — or hidden) stays shown. */}
          {tag.parent_id && !parentChoices.some((c) => c.id === tag.parent_id) && (
            <option value={tag.parent_id}>{parentTag ? `#${pathOf(parentTag.id, parentTag.name)}` : t("(not a tag)")}</option>
          )}
          {parentChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </Select>
      </label>
      <Pressable type="button" className="schema-lens-action" onClick={onClose}>{t("Cancel")}</Pressable>
    </div>
  );
}
