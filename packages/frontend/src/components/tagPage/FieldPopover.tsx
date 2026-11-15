import { useEffect, useRef, useState } from "react";
import type { Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { onFieldEditorRequest } from "../../lib/tagFieldRequest";
import { confirmFieldRemoval } from "../confirmFieldRemoval";
import { FieldEditor, type FieldDef } from "../TagsPanel";
import type { useFieldUsage } from "../../hooks/useFieldUsage";
import { Pressable, Popover, usePopover } from "../ui";
import type { FieldModel } from "./fieldModel";
import type { useSchemaDraft } from "./structure/useSchemaDraft";

const keyOf = (f: FieldDef) => f.name || f.key || "";

/** One field's settings — name, type, required, default, delete — in a popover
 *  opened where the field was pressed: a chip under the title, or a column name
 *  of the tag's table (lib/tagFieldRequest requestFieldEditor). It edits the
 *  tag's schema draft (useSchemaDraft), the same path the old structure panel
 *  used; a field another tag has the name of stays here, marked, and is left
 *  out of the save until renamed. Mounted once per tag page; renders nothing
 *  while closed. */
export default function FieldPopover({ tag, draft, fieldModel, fieldUsage, canManage }: {
  tag: Tag;
  draft: Pick<ReturnType<typeof useSchemaDraft>, "fields" | "setFields" | "save" | "flush">;
  fieldModel: Pick<FieldModel, "clashesOf" | "fieldClashes" | "takenNames">;
  fieldUsage: ReturnType<typeof useFieldUsage>;
  canManage: boolean;
}) {
  const [open, setOpen] = useState<{ index: number; at: { x: number; y: number } } | null>(null);
  const latest = useRef({ draft, canManage });
  latest.current = { draft, canManage };

  useEffect(() => onFieldEditorRequest(tag.id, ({ field, at }) => {
    const { draft: current, canManage: allowed } = latest.current;
    if (!allowed) return;
    if (field === null) {
      // A new field starts unnamed and is not saved until it has a name.
      current.setFields([...current.fields, { name: "", type: "text" }]);
      setOpen({ index: current.fields.length, at });
      return;
    }
    const index = typeof field === "number" ? field : current.fields.findIndex((f) => keyOf(f) === field);
    if (index >= 0 && index < current.fields.length) setOpen({ index, at });
  }), [tag.id]);

  // Another tag's page must not keep this one open.
  useEffect(() => () => setOpen(null), [tag.id]);

  if (!open || !draft.fields[open.index]) return null;
  return <FieldPopoverBody key={open.index} index={open.index} at={open.at} draft={draft} fieldModel={fieldModel}
    fieldUsage={fieldUsage} onClose={() => { setOpen(null); void draft.flush(); }} />;
}

function FieldPopoverBody({ index, at, draft, fieldModel, fieldUsage, onClose }: {
  index: number; at: { x: number; y: number };
  draft: Pick<ReturnType<typeof useSchemaDraft>, "fields" | "setFields" | "save">;
  fieldModel: Pick<FieldModel, "clashesOf" | "fieldClashes" | "takenNames">;
  fieldUsage: ReturnType<typeof useFieldUsage>;
  onClose: () => void;
}) {
  const t = useT();
  const popover = usePopover<HTMLElement>({ open: true, onClose, at });
  const { fields, setFields, save } = draft;
  const field = fields[index];

  /** Show the edit now; save everything except the fields held back by a same-name clash. */
  const change = (next: FieldDef[]) => {
    setFields(next);
    const held = fieldModel.clashesOf(next);
    save({ fields: next.filter((f) => !held.has(keyOf(f))) });
  };
  const patchField = (idx: number, patch: Partial<FieldDef>) => change(fields.map((f, i) => i === idx ? { ...f, ...patch } : f));
  async function remove() {
    // A used field, or one whose usage is unknown, asks first (hooks/useFieldUsage).
    if (!(await confirmFieldRemoval(field.label || keyOf(field), keyOf(field), fieldUsage))) return;
    change(fields.filter((_, i) => i !== index));
    onClose();
  }

  return (
    <Popover popover={popover} label={t("Field settings")} className="tag-field-popover">
      <FieldEditor f={field} idx={index} fields={fields} patchField={patchField}
        clashes={fieldModel.fieldClashes} takenNames={fieldModel.takenNames} fieldUsage={fieldUsage} />
      <div className="tag-field-popover-actions">
        <Pressable type="button" className="tag-field-popover-delete" onClick={() => void remove()}>{t("Delete field")}</Pressable>
        <Pressable type="button" className="tag-field-popover-done" onClick={onClose}>{t("OK")}</Pressable>
      </div>
    </Popover>
  );
}
