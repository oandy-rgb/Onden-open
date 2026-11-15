import { useFieldSave } from "./useFieldSave";
// Custom (free-form) attribute row — for attributes whose keys aren't
// in any of the node's class-tag schemas.
//
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.
//
// The advanced toggle exposes is_inheritable ("Shares to children": the
// value also shows on notes nested under this one). Normal use just edits the
// value. The value's type is kept as it was (inferred when the property was
// added): a note fills values; types are a tag's structure, set on the tag
// page (user decision 2026-10-18).

import { useEffect, useState } from "react";
import type { NodeAttribute } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { isEnterKey, isEscapeKey } from "../../lib/keys";
import { Checkbox, Pressable, TextField } from "../ui";

export function CustomRow({
  attr,
  onSave,
  onDelete,
  readOnly = false,
}: {
  attr: NodeAttribute;
  onSave: (value: string, type: NodeAttribute["value_type"], is_inheritable: boolean) => Promise<void> | void;
  onDelete: () => void;
  /** Show the value only (a read-only note): no edit, no remove. */
  readOnly?: boolean;
}) {
  const t = useT();
  const { save, saving } = useFieldSave();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(attr.value);
  const [advanced, setAdvanced] = useState(false);
  const [type, setType] = useState(attr.value_type);
  const [inh, setInh] = useState(attr.is_inheritable);

  useEffect(() => {
    if (!editing) {
      setValue(attr.value);
      setType(attr.value_type);
      setInh(attr.is_inheritable);
    }
  }, [attr, editing]);

  const commit = async () => { if (await save(() => onSave(value, type, inh))) setEditing(false); };

  if (readOnly) {
    return (
      <>
        <span className="attr-key">📝 {attr.key}</span>
        <span className="attr-value attr-value--readonly">{attr.value || <em>{t("empty")}</em>}</span>
      </>
    );
  }

  if (!editing) {
    return (
      <>
        <span className="attr-key">📝 {attr.key}</span>
        <Pressable className="attr-value attr-value--clickable" onClick={() => setEditing(true)}>
          {attr.value || <em>{t("empty")}</em>}
        </Pressable>
        <Pressable className="attr-delete-btn" onClick={onDelete} title={t("Remove")}>✕</Pressable>
      </>
    );
  }

  return (
    <>
      <span className="attr-key">📝 {attr.key}</span>
      <TextField
        autoFocus
        className="attr-input attr-input--value"
        readOnly={saving}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterKey(e)) { void commit(); }
          if (isEscapeKey(e)) setEditing(false);
        }}
      />
      <Pressable
        className="attr-cancel-btn"
        title={advanced ? t("Hide sharing") : t("Show sharing")}
        onClick={() => setAdvanced((v) => !v)}
      >
        {advanced ? "▴" : "▾"}
      </Pressable>
      {advanced && (
        <>
          <label className="attr-inheritable-toggle" title={t("Also show this field on items nested under this one")}>
            <Checkbox checked={inh} onChange={(e) => setInh(e.target.checked)} />
            {t("Shares to children")}
          </label>
        </>
      )}
      <Pressable disabled={saving} className="attr-save-btn" onClick={() => { void commit(); }}>✓</Pressable>
      <Pressable className="attr-cancel-btn" onClick={() => setEditing(false)}>✕</Pressable>
    </>
  );
}
