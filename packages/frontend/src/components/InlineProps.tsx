import { useMemo } from "react";
import type { Tag } from "../lib/api";
import { useT } from "../lib/i18n";
import "./InlineProps.css";
import { tagFields } from "../lib/tagFields";
import { isShownPropertyKey } from "../lib/childFields";

// Inline metadata strip — the node's KEY properties surfaced at the TOP of the
// note body (Notion/Tana "properties above the doc"), reading as ordinary
// `label: value` metadata rather than a schema editor (surface-no-programmer-ui).
//
// Why this exists alongside FeaturedFields: FeaturedFields surfaces the node's
// applied class-tag *schema* fields as editable cells. But a note's plain,
// own custom properties (a `due`, a `source`, a `url` someone just typed) lived
// ONLY in the right Inspector's "Extra fields" — invisible until you opened the
// panel. This strip pulls those forward so the important facts about a note are
// readable in-place. It is read-only and additive: the Inspector keeps the full
// editable list (add / edit / remove / inheritance), this is just surfacing.
//
// "Key props" rule (deliberate, documented):
//   • SOURCE = node.attrs — the same flattened {key: value} snapshot the
//     Inspector's "Extra fields" reads (NodeAttributesPanel own-attributes), so
//     there is no parallel store.
//   • HIDE empty values — a blank prop is noise at the top of a note.
//   • HIDE system-reserved keys (prefix `_`) — backend machinery, never edited
//     by the user (mirrors NodeAttributesPanel's `_`-prefix filter).
//   • HIDE render-machinery keys (ink/pdf payloads, and sketch_data left by
//     the removed Excalidraw sketches) — these are the
//     editor's own storage, not human-facing facts.
//   • HIDE keys already claimed by an applied class-tag schema — those render in
//     FeaturedFields right above this strip, so we don't double-surface them.
// What's left is the note's own, most-relevant plain properties.

type Props = {
  /** The node's flattened attribute snapshot (ContentNode.attrs). */
  attrs: Record<string, string>;
  /** Applied class tags carrying a schema — their field names are excluded
   *  because FeaturedFields renders them as editable cells just above. */
  classTags: Tag[];
};

export default function InlineProps({ attrs, classTags }: Props) {
  const t = useT();

  const schemaKeys = useMemo(() => {
    const s = new Set<string>();
    for (const tag of classTags) {
      for (const f of tagFields(tag)) s.add(f.name);
    }
    return s;
  }, [classTags]);

  const props = useMemo(() => {
    return Object.entries(attrs)
      .filter(([key, value]) =>
        value != null &&
        String(value).trim() !== "" &&
        isShownPropertyKey(key) &&
        !schemaKeys.has(key))
      // Stable, predictable order; the snapshot has no inherent ordering.
      .sort(([a], [b]) => a.localeCompare(b));
  }, [attrs, schemaKeys]);

  if (props.length === 0) return null;

  return (
    <div className="inline-props" role="group" aria-label={t("Properties")}>
      {props.map(([key, value]) => (
        <span key={key} className="inline-prop" title={`${key}: ${value}`}>
          <span className="inline-prop-label">{key}</span>
          <span className="inline-prop-value">{value}</span>
        </span>
      ))}
    </div>
  );
}
