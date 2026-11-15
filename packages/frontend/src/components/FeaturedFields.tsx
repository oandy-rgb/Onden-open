import { useFieldSave } from "./attributes/useFieldSave";
import { Suspense, useEffect, useRef, useState } from "react";
import type { SchemaField, Tag } from "../lib/api";
import { storageType } from "@onden/markdown";
import { useT } from "../lib/i18n";
import "./FeaturedFields.css";
import { isEscapeKey } from "../lib/keys";
import { useAllNodes } from "../lib/appStore";
import { lazyWithReload } from "../lib/lazyWithReload";
import { readOnlyFieldText } from "../lib/fieldText";
import { tagFields } from "../lib/tagFields";
import { Pressable } from "./ui";
import { useFocusWhenControlAppears } from "../hooks/useFocusWhenControlAppears";

const SchemaRow = lazyWithReload(() => import("./attributes").then((m) => ({ default: m.SchemaRow })));

/** "field_1"… — the name older versions of TagsPanel gave a field the user had not named. */
const PLACEHOLDER_FIELD = /^field_\d+$/;

// doc 09 #4 — "featured fields" pinned on the node. A class_tag carries a
// schema; its key fields render as compact, editable cells at the top of the
// note (Anytype featured relations / Trilium promoted attributes), so the
// type + key fields are always visible *on the object*, not buried in the
// inspector. The same node_attributes write path as the inspector, just a
// compact header presentation. Editing here IS editing the instance's fields.

type AttrSet = (key: string, value: string, valueType: string) => Promise<void> | void;

type Props = {
  /** Applied class tags (already filtered to those carrying a schema). */
  classTags: Tag[];
  /** Current attribute values for this node (ContentNode.attrs). */
  attrs: Record<string, string>;
  onAttrSet?: AttrSet;
};

export default function FeaturedFields({ classTags, attrs, onAttrSet }: Props) {
  const t = useT();
  // Union the schema fields across every applied class tag, deduped by name —
  // a node can carry more than one class tag (Tana's multi-supertag behaviour).
  // Rollup/computed fields are skipped: they have no stored value and stay
  // read-only in the inspector.
  const fields: SchemaField[] = [];
  const seen = new Set<string>();
  for (const tag of classTags) {
    for (const f of tagFields(tag)) {
      if (f.rollup || seen.has(f.name)) continue;
      // An unnamed, empty field says nothing on the note; it appears once it
      // is named on the tag page or given a value.
      if (PLACEHOLDER_FIELD.test(f.name) && !f.label && !attrs[f.name]) continue;
      seen.add(f.name);
      fields.push(f);
    }
  }
  if (fields.length === 0) return null;

  return (
    <div className="featured-fields" role="group" aria-label={t("Fields")}>
      {fields.map((f) => (
        <FeaturedCell key={f.name} field={f} value={attrs[f.name] ?? ""} onAttrSet={onAttrSet} />
      ))}
    </div>
  );
}

function FeaturedCell({ field, value, onAttrSet }: { field: SchemaField; value: string; onAttrSet?: AttrSet }) {
  const t = useT();
  const label = field.label ?? field.name;
  const editable = !!onAttrSet;
  // Optimistic local value so the cell updates immediately on commit, before the
  // workspace data round-trips and repopulates node.attrs. Re-syncs if the
  // upstream value changes (external edit / agent / refresh).
  const [local, setLocal] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setLocal(value); }, [value, editing]);
  // Pressing the cell opens its control (SchemaRow, loaded on first use): the caret goes into it, so a
  // press then typing writes the value. SchemaRow does not focus itself: the tag card shows the same
  // controls open all the time, where taking the focus would be wrong. Only this press-to-open path asks
  // for it, and it waits for the control to actually mount rather than polling (hooks/useFocusWhenControlAppears).
  const editor = useRef<HTMLSpanElement>(null);
  useFocusWhenControlAppears(editor, editing);

  const nodes = useAllNodes();
  const shown = readOnlyFieldText(field, local, nodes);
  const { save, saving } = useFieldSave();
  async function set(next: string) {
    setLocal(next);
    if (next === value || await save(() => onAttrSet?.(field.name, next, storageType(field.type)))) setEditing(false);
  }

  if (field.type === "boolean") {
    const on = local === "true";
    return (
      <Pressable
        className={`ff-cell ff-cell--bool${on ? " on" : ""}`}
        disabled={!editable || saving}
        onClick={() => set(on ? "false" : "true")}
        title={label}
      >
        <span className="ff-label">{label}</span>
        <span className="ff-check">{on ? "✓" : "○"}</span>
      </Pressable>
    );
  }

  if (editing && editable) {
    // The same controls as the tag card and the info panel (attributes/SchemaRow), loaded on first use.
    return (
      <span ref={editor} className="ff-cell ff-cell--editing" onKeyDown={(e) => { if (isEscapeKey(e)) setEditing(false); }}>
        <Suspense fallback={<span className="ff-label">{label}</span>}>
          <SchemaRow field={field} value={local} allNodes={nodes} onSave={set} />
        </Suspense>
      </span>
    );
  }

  return (
    <Pressable
      className="ff-cell"
      disabled={!editable || saving}
      onClick={() => setEditing(true)}
      title={editable ? t("Edit {label}", { label }) : label}
    >
      <span className="ff-label">{label}</span>
      <span className={`ff-value${shown ? "" : " ff-value--empty"}`}>{shown || t("Empty")}</span>
    </Pressable>
  );
}
