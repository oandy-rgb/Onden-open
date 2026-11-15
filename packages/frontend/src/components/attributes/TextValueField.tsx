// A text / number field's value: the box itself, always there (no click first).
// It writes when the box loses focus or on Enter, and only if the text changed;
// also when the box goes away or the page is hidden with text still unsaved
// (useFieldDraft), always to the note the text was typed on.
// Nothing is written while an input method is composing (a half-typed 注音
// would be saved); the write waits for the composition to end. A failed write
// keeps the draft in the box (the writer reports it).

import { useRef } from "react";
import type { SchemaField } from "../../lib/api";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { isEnterKey, isEscapeKey, isImeComposing } from "../../lib/keys";
import { useFieldDraft } from "../../hooks/useFieldDraft";
import { TextArea, TextField } from "../ui";

type Save = (next: string) => Promise<void> | void;

export function TextValueField({
  field, value, onSave, label, scope = "",
}: {
  field: Pick<SchemaField, "type">;
  value: string;
  onSave: Save;
  /** The field's name, for assistive tech and the empty-box hint. */
  label: string;
  /** What the box belongs to (the note's id): a draft typed under another scope is never shown or saved here. */
  scope?: string;
}) {
  const t = useT();
  // The save as it was when typing began: it is bound to that note, the latest one may not be.
  const draft = useFieldDraft<Save>({
    target: onSave, targetKey: `${scope}\u0000${label}`, committed: value,
    commit: async (save, text) => {
      try { await save(text); } catch (error) { writeErrors.report(error, addToast); throw error; }
    },
  });
  const composing = useRef(false);

  // `text`: the box's own text when this render's draft may not have caught up (the end of a composition).
  const commit = (text = draft.text) => {
    if (composing.current) return;
    if (text !== draft.text) draft.edit(text);
    // A refused text is sent again when the person asks (Enter, leaving the box), as before.
    void (draft.status === "rejected" ? draft.retry() : draft.flush());
  };
  const saving = draft.status === "saving";
  const multiline = field.type === "textarea" || field.type === "richtext";
  const common = {
    className: "attr-input attr-input--value attr-input--direct",
    "aria-label": label,
    placeholder: field.type === "number" ? "—" : t("Add {field}…", { field: label }),
    readOnly: saving,
    value: draft.text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => draft.edit(e.target.value),
    onBlur: () => commit(),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      // The box lost focus mid-composition: its blur write was held back.
      if (!e.currentTarget.matches(":focus")) commit(e.currentTarget.value);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (isEscapeKey(e)) { draft.discard(); return; }
      if (isImeComposing(e)) return;
      if (isEnterKey(e) && !e.shiftKey && !multiline) { e.preventDefault(); commit(); }
    },
  };
  if (multiline) return <TextArea rows={2} {...common} />;
  return <TextField type={field.type === "number" ? "number" : "text"} {...common} />;
}
