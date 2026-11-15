import { runBackgroundWrite } from "../../lib/data";
// Schema-driven attribute row.
//
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.
// Dispatches to per-type editors (boolean/date/number/select inline,
// text/number/textarea/richtext as boxes you type in (TextValueField), media/relation via their
// specialised editors). Cardinality="many" wraps in MultiValueEditor.

import { useState } from "react";
import { readOnlyFieldText } from "../../lib/fieldText";
import { isListValue } from "@onden/markdown";
import type { ContentNode, SchemaField } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { isEnterKey, isEscapeKey } from "../../lib/keys";
import { TextValueField } from "./TextValueField";
import { DateValueField } from "./DateValueField";
import { OptionChips, fitsAsChips } from "./OptionChips";
import { RelationFieldEditor } from "./RelationFieldEditor";
import { MediaFieldEditor } from "./MediaFieldEditor";
import { MultiValueEditor } from "./MultiValueEditor";
import { StarRating } from "./StarRating";
import { Pressable, Select, Switch, TextField } from "../ui";
import "../NodeAttributesPanel.css";

/** Field types whose write gate takes a stored list as it is (not per element). */
const ANY_LIST_TYPES: ReadonlySet<string> = new Set(["text", "textarea", "richtext", "relation"]);

export function SchemaRow({
  field,
  value,
  allNodes,
  onSave,
  readOnly = false,
  onAddOption,
  onOpenNote,
  scope,
}: {
  field: SchemaField;
  value: string;
  allNodes: ContentNode[];
  onSave: (next: string) => Promise<void> | void;
  /** Show the value only (a read-only note): no editor. */
  readOnly?: boolean;
  /** A select field offers 「＋ 新增選項…」: adds the option to the tag's
   *  field and picks it; true when accepted. Only for the tag's owner —
   *  without it, only the existing options can be picked. */
  onAddOption?: (option: string) => Promise<boolean>;
  /** Open the note a relation field links to. */
  onOpenNote?: (nodeId: string) => void;
  /** The note these fields belong to; a typed draft never moves to another note's box. */
  scope?: string;
}) {
  const label = field.label ?? field.name;
  const keyCell = <span className="attr-key" title={field.name}>{label}</span>;

  if (readOnly) {
    const text = readOnlyFieldText(field, value, allNodes);
    return (
      <>
        {keyCell}
        <span className="attr-value attr-value--readonly">{text || "—"}</span>
      </>
    );
  }

  // A list gets the list editor: a field with cardinality 'many', or a list
  // stored under a field the write gate takes any value for (a relation, or
  // text: a frontmatter `authors: [Alice, Bob]`, an imported relation list).
  // Without it the list would show as raw JSON, or a relation pick would
  // replace the whole list (D117). The stored value is a JSON array string
  // (@onden/markdown attributeValues / encodeValues); a single value under a
  // 'many' field reads as a one-item list.
  const list = field.cardinality === "many" || (isListValue(value) && ANY_LIST_TYPES.has(field.type));
  if (list && field.type !== "boolean") {
    return (
      <>
        {keyCell}
        <MultiValueEditor field={field} value={value} allNodes={allNodes} onSave={onSave} />
      </>
    );
  }

  // ── Direct widgets ─────────────────────────────────────────────────────
  // Every type shows its control as it is (no press-to-edit step): a switch,
  // option chips, a day button that opens quick picks, boxes you type in.

  if (field.type === "boolean") {
    return (
      <>
        {keyCell}
        <Switch on={value === "true" || value === "1"} label={label}
          onChange={(on) => runBackgroundWrite(onSave(on ? "true" : "false"))} />
      </>
    );
  }

  if (field.type === "date") {
    return (
      <>
        {keyCell}
        <DateValueField label={label} value={value} onSave={(next) => runBackgroundWrite(onSave(next))} />
      </>
    );
  }

  if (field.type === "rating") {
    return (
      <>
        {keyCell}
        <StarRating value={value} max={field.max ?? 5} onSave={(next) => runBackgroundWrite(onSave(next))} />
      </>
    );
  }

  if (field.type === "number") {
    return (
      <>
        {keyCell}
        <TextValueField field={field} label={label} value={value} onSave={onSave} scope={scope} />
      </>
    );
  }

  if (field.type === "select") {
    return (
      <>
        {keyCell}
        <SelectValue field={field} value={value} onSave={onSave} onAddOption={onAddOption} />
      </>
    );
  }

  if (field.type === "media") {
    return (
      <>
        {keyCell}
        <MediaFieldEditor value={value} onSave={onSave} />
      </>
    );
  }

  if (field.type === "relation") {
    return (
      <>
        {keyCell}
        <RelationFieldEditor
          value={value}
          allNodes={allNodes}
          relationConstraint={field.relation_supertag}
          onSave={onSave}
          onOpenNote={onOpenNote}
        />
      </>
    );
  }

  // text / textarea / richtext: a box you type in.
  return (
    <>
      {keyCell}
      <TextValueField field={field} label={label} value={value} onSave={onSave} scope={scope} />
    </>
  );
}

const NEW_OPTION = "\u0000new-option";

/** A select field's value: the tag's options as chips (a dropdown when they
 *  would not fit a row), and — for the tag's owner —
 *  「＋ 新增選項…」, which turns the select into a name input. An option just
 *  added stays listed until the refreshed tag carries it. */
function SelectValue({ field, value, onSave, onAddOption }: {
  field: SchemaField;
  value: string;
  onSave: (next: string) => Promise<void> | void;
  onAddOption?: (option: string) => Promise<boolean>;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const listed = [...(field.options ?? []), ...added.filter((opt) => !(field.options ?? []).includes(opt))];
  // A stored value the tag no longer lists (option removed or renamed) stays
  // visible and selected; a native select would otherwise show it as empty.
  const options = value && !listed.includes(value) ? [...listed, value] : listed;
  const label = field.label ?? field.name;

  const commit = async () => {
    const option = draft.trim();
    if (!option || busy || !onAddOption) return;
    if (options.includes(option)) { // already an option: just pick it
      setAdding(false); setDraft("");
      runBackgroundWrite(onSave(option));
      return;
    }
    setBusy(true);
    const ok = await onAddOption(option);
    setBusy(false);
    if (ok) { setAdded((list) => [...list, option]); setAdding(false); setDraft(""); }
  };

  if (adding && onAddOption) {
    return (
      <TextField
        autoFocus
        className="attr-input attr-input--value"
        aria-label={t("New option for {field}", { field: label })}
        placeholder={t("New option")}
        value={draft}
        readOnly={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterKey(e)) { e.preventDefault(); void commit(); }
          if (isEscapeKey(e)) { setAdding(false); setDraft(""); }
        }}
        onBlur={() => { if (!draft.trim() && !busy) setAdding(false); }}
      />
    );
  }

  const current = value && !options.includes(value) ? [...options, value] : options;
  if (fitsAsChips(current)) {
    return (
      <OptionChips label={label} options={current} value={value} onPick={(next) => runBackgroundWrite(onSave(next))}
        trailing={onAddOption && (
          <Pressable className="attr-choice attr-choice--add" onClick={() => setAdding(true)}>{t("+ New option…")}</Pressable>
        )} />
    );
  }
  return (
    <Select
      className="attr-input attr-input--value"
      aria-label={label}
      value={value}
      onChange={(e) => {
        if (e.target.value === NEW_OPTION) { setAdding(true); return; }
        runBackgroundWrite(onSave(e.target.value));
      }}
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
      {onAddOption && <option value={NEW_OPTION}>{t("+ New option…")}</option>}
    </Select>
  );
}
