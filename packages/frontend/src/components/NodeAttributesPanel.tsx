import { TagName } from "./FunctionChip";
import { propertyWriter, reads, tagSchemaWriter } from "../lib/data";
// Schema-driven properties panel — option C from the substrate-first plan.
//
// Behaviour:
//   • One card per tag the node carries, holding that tag's schema fields as
//     type-appropriate controls you use directly, name above value (a day
//     with quick picks, a switch, option chips, boxes to type in; a linked
//     note is a pill with 「換一則」). Field labels and order come from the tag's
//     schema, not from the user. The host draws each card's head
//     (renderTagHead: the tag's path, functions, inheritance — NoteTagCards).
//   • A field several of the note's tags define is ONE value: it shows once,
//     in the first card that defines it, with "also used by #other".
//   • Anything left over (attributes whose keys aren't in any of the
//     applied tags' schemas) lands in a final card of old fields, only when
//     there is one. A note can't add a free-form property any more: a new
//     value goes in a tag's field.
//   • A note fills VALUES only (user decision 2026-10-18): no promoting a
//     property into a tag field, no field renames, types or option lists
//     here — the tag page owns a tag's structure (its 「升級成欄位」 takes
//     the promote). The one exception: the tag's owner may add a NEW option
//     to a select field inline (canEditTags); everyone else picks existing
//     options.
//   • Substrate concepts like `value_type` and `is_inheritable` aren't
//     exposed by default — the field type comes from the schema, and
//     inheritability lives behind a tiny advanced toggle on each custom row.
//
// Persistence belongs to propertyWriter, either directly or through the
// compatibility onUpsert / onRemove actions. The panel owns drafts and errors.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ContentNode, NodeAttribute, SchemaField, Tag } from "../lib/api";
import { useNode, useTagRows } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { confirmDialog } from "./ConfirmDialog";
import "./NodeAttributesPanel.css";

// Day 6 panel decomposition — sub-components moved to ./attributes/.
import { SchemaRow } from "./attributes/SchemaRow";
import { CustomRow } from "./attributes/CustomRow";
import { storageType } from "@onden/markdown";
import { withSelectOption } from "../lib/tagFieldEdits";
import {
  INTERNAL_ATTRIBUTE_KEYS,
  type InheritedAttr,
  type RollupAttr,
  rollupDescription,
} from "./attributes/utils";
import { tagFields, type TagField } from "../lib/tagFields";

type Props = {
  nodeId: string;
  /** Tags applied to this node, in card order. The panel reads each tag's
   *  fields (tagFields: its own and inherited ones) and renders one card per
   *  tag (a label tag's card has no field rows). */
  classTags?: Tag[];
  /** Draw only these tags' cards (default: every tag in `classTags`). The
   *  other tags still claim their fields, so a value shown elsewhere never
   *  falls into "Other properties". */
  cardTagIds?: readonly string[];
  /** Draw the final "Other properties" card (default). */
  showOther?: boolean;
  /** Workspace nodes — used by the relation widget to typeahead-pick a
   *  target node. Filtered down by `field.relation_supertag` when present. */
  allNodes?: ContentNode[];
  /** The person may read but not change this note: values only, no add or
   *  remove. */
  readOnly?: boolean;
  /** A tag card's head; defaults to "#name". */
  renderTagHead?: (tag: Tag) => ReactNode;
  /** Drawn at the end of a tag card (NoteTagCards: the owner's
   *  「編輯 #X 的欄位 →」). */
  renderTagFoot?: (tag: Tag) => ReactNode;
  /** The person may define tags (the owner: lib/capabilities.ts canEdit of a
   *  class_tag) — only then may a select field get a new option from here. */
  canEditTags?: boolean;
  /** Title of the card of properties no tag has a field for. */
  otherLabel?: string;
  /** Drawn after an old property's value (NoteTagCards: 「變成 #X 的欄位」). */
  renderLegacyAction?: (attr: NodeAttribute) => ReactNode;
  onUpsert?: (key: string, value: string, opts: { value_type?: NodeAttribute["value_type"]; is_inheritable?: boolean }) => Promise<unknown>;
  onRemove?: (key: string) => Promise<unknown>;
  /** Open the note a relation field links to (its pill). */
  onOpenNote?: (nodeId: string) => void;
  /** Called after the owner added a select option to a tag's field here.
   *  Lets the host reload `classTags`. */
  onTagsChanged?: () => void | Promise<void>;
};

export default function NodeAttributesPanel({
  nodeId, classTags = [], cardTagIds, showOther = true, allNodes = [], readOnly = false, renderTagHead, renderTagFoot, canEditTags = false, otherLabel, renderLegacyAction, onUpsert, onRemove, onOpenNote, onTagsChanged,
}: Props) {
  const t = useT();
  const [attrs, setAttrs] = useState<NodeAttribute[]>([]);
  const [inherited, setInherited] = useState<InheritedAttr[]>([]);
  const [rollups, setRollups] = useState<RollupAttr[]>([]);
  const [loading, setLoading] = useState(false);

  // Offline fallback source: the store's ContentNode.attrs map is kept current by
  // propertyWriter.set (incl. optimistic OFFLINE edits + the mirror), so
  // when the network read fails we show these instead of wiping the panel blank.
  const storeNodeAttrs = useNode(nodeId)?.attrs;
  const storeAttrsRef = useRef(storeNodeAttrs);
  useEffect(() => { storeAttrsRef.current = storeNodeAttrs; }, [storeNodeAttrs]);
  // Monotonic load token so a stale in-flight fetch can't overwrite a newer one.
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    if (!nodeId) return;
    // Stale-response guard (M12): a fast node switch can leave an earlier node's
    // fetch in flight; when it resolves it must NOT overwrite the panel with the
    // previous node's attributes. Bump a generation token and drop any write
    // from a superseded load.
    const gen = ++loadGenRef.current;
    setLoading(true);
    try {
      const { own, inherited, rollups } = await reads.notes.attributePanel<InheritedAttr, RollupAttr>(nodeId);
      if (gen !== loadGenRef.current) return; // superseded by a newer node's load
      setAttrs(own);
      setInherited(inherited.filter((a) => !INTERNAL_ATTRIBUTE_KEYS.has(a.key)));
      setRollups(rollups);
    } catch {
      if (gen !== loadGenRef.current) return; // stale failure — don't clobber the new node
      // Offline / network fail: DON'T wipe the panel (and don't make a just-typed
      // offline value vanish — upsert()'s await load() lands here). Fall back to
      // the store's attrs, which hold the current value incl. offline edits.
      const fallback = storeAttrsRef.current ?? {};
      // The local copy of each row keeps its type and "shares to children" flag: a row shown as plain text
      // here would be written back as text, not shared (scan 06 M5).
      const rows = await Promise.all(Object.entries(fallback).map(async ([key, value]) => {
        const record = await reads.notes.attributeRecord(nodeId, key).catch(() => null);
        return { key, value, value_type: record?.value_type ?? "text", is_inheritable: record?.is_inheritable ?? false, source: record?.source ?? "ui" };
      }));
      if (gen !== loadGenRef.current) return;
      setAttrs(rows as NodeAttribute[]);
      setInherited([]);
      setRollups([]);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void load(); }, [load]);

  const upsert = useCallback(async (
    key: string,
    value: string,
    value_type: NodeAttribute["value_type"] | undefined,
    is_inheritable: boolean | undefined,
  ) => {
    if (key.startsWith("_")) return; // system-reserved
    // A refusal is reported once as a notice (the writer, or the field's save in useFieldSave), not again inside the panel.
    if (onUpsert) await onUpsert(key, value, { value_type, is_inheritable });
    else await propertyWriter.set(nodeId, key, value, { value_type, is_inheritable });
    await load();
  }, [nodeId, onUpsert, load]);

  const remove = useCallback(async (key: string) => {
    if (!(await confirmDialog(t(`Remove "{key}"?`, { key }), { confirmLabel: t("Remove"), danger: true }))) return;
    try {
      if (onRemove) {
        await onRemove(key);
      } else {
        await propertyWriter.remove(nodeId, key);
      }
      await load();
    } catch {
      // reported as a notice by the writer
    }
  }, [nodeId, onRemove, load, t]);

  // The owner adds a new option to a select field of `tag`'s own (not an
  // inherited one): saved like any edit of the tag's fields, then the value
  // is set. True when both were accepted (or durably queued).
  const addSelectOption = useCallback(async (tag: Tag, field: SchemaField, option: string): Promise<boolean> => {
    const fields = withSelectOption(tag.schema_fields ?? [], field.name, option);
    if (!fields) return false;
    try {
      await tagSchemaWriter.update(tag.id, { fields });
    } catch {
      return false; // Reported by the tag-schema writer.
    }
    await onTagsChanged?.();
    try {
      await upsert(field.name, option.trim(), storageType(field.type), undefined);
      return true;
    } catch {
      return false; // upsert reports the error
    }
  }, [onTagsChanged, upsert]);

  // Build value lookup for fast schema-row rendering.
  const attrByKey = useMemo(() => {
    const m = new Map<string, NodeAttribute>();
    for (const a of attrs) m.set(a.key, a);
    return m;
  }, [attrs]);

  // Each field is shown once, in the first tag card that defines it; the
  // later tags that define the same name are listed as "also used by".
  const cards = useMemo(() => tagCards(classTags), [classTags]);
  // Names for the "inherited from #tag" line under an inherited field.
  const catalog = useTagRows();
  const tagName = useCallback((id: string) => catalog?.find((tag) => tag.id === id)?.name ?? "?", [catalog]);
  const claimedKeys = useMemo(() => new Set(cards.flatMap(({ fields }) => fields.map(({ field }) => field.name))), [cards]);

  const customAttrs = attrs.filter(
    (a) => !claimedKeys.has(a.key) && !a.key.startsWith("_") && !INTERNAL_ATTRIBUTE_KEYS.has(a.key),
  );
  const drawn = cardTagIds ? cards.filter(({ tag }) => cardTagIds.includes(tag.id)) : cards;
  const showsOther = showOther && (customAttrs.length > 0 || rollups.length > 0 || inherited.length > 0);

  return (
    <div className="attr-panel">
      {loading && <p className="attr-panel-loading">{t("Loading…")}</p>}

      {/* One card per applied tag — fields ordered by schema. */}
      {drawn.map(({ tag, fields }) => (
        <section key={tag.id} className="attr-panel-section tag-card" aria-label={tag.schema_module ? tag.name : `#${tag.name}`}
          style={{ "--tag-color": tag.color } as CSSProperties}>
          {renderTagHead ? renderTagHead(tag) : (
            <header className="attr-panel-section-label attr-panel-section-label--colored"><TagName tag={tag} /></header>
          )}
          {fields.length > 0 && (
            <ul className="attr-panel-list">
              {fields.map(({ field, alsoUsedBy }) => (
                <li key={field.name} className="attr-row">
                  <SchemaRow
                    field={field}
                    value={attrByKey.get(field.name)?.value ?? ""}
                    allNodes={allNodes}
                    readOnly={readOnly}
                    onOpenNote={onOpenNote}
                    scope={nodeId}
                    onSave={(v) => upsert(field.name, v, storageType(field.type), undefined)}
                    onAddOption={canEditTags && field.type === "select" && (tag.schema_fields ?? []).some((own) => own.name === field.name)
                      ? (option) => addSelectOption(tag, field, option) : undefined}
                  />
                  {field.inherited_from && (
                    <span className="attr-shared attr-inherited">
                      {t("from #{name}", { name: tagName(field.inherited_from) })}
                    </span>
                  )}
                  {alsoUsedBy.length > 0 && (
                    <span className="attr-shared">
                      {t("also used by {tags}", { tags: alsoUsedBy.map((other) => `#${other.name}`).join(", ") })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {renderTagFoot?.(tag)}
        </section>
      ))}

      {/* Old properties — anything not covered by a tag's schema. Reserved
          keys (prefixed with _) are hidden entirely; they're system-derived
          and users shouldn't be editing them from this panel anyway. */}
      {showsOther && (
      <section className="attr-panel-section tag-card tag-card--other" aria-label={otherLabel ?? t("Other properties")}>
        {customAttrs.length > 0 && <>
        <header className="attr-panel-section-label">{otherLabel ?? t("Other properties")}</header>
        <ul className="attr-panel-list">
          {customAttrs.map((a) => (
            <li key={a.key} className="attr-row attr-row--custom">
              <CustomRow
                attr={a}
                readOnly={readOnly}
                onSave={(value, value_type, is_inheritable) =>
                  upsert(a.key, value, value_type, is_inheritable)}
                onDelete={() => remove(a.key)}
              />
              {!readOnly && renderLegacyAction?.(a)}
            </li>
          ))}
        </ul>
        </>}

      {/* Computed — synthesized attributes (Knuth bottom-up). Each row is
          a field on one of the applied class tag's schemas whose `rollup`
          spec told the server to aggregate something across descendants.
          Always read-only; the value is derived, not stored. */}
      {rollups.length > 0 && (
        <section className="attr-panel-section attr-panel-rollup">
          <header className="attr-panel-section-label">{t("Calculated from items below")}</header>
          <ul className="attr-panel-list">
            {rollups.map((r) => (
              <li key={r.key} className="attr-row attr-row--rollup">
                <span className="attr-key" title={rollupDescription(r)}>{r.label}</span>
                <span className="attr-value attr-value--rollup" title={rollupDescription(r)}>
                  {Number.isFinite(r.value) ? r.value : "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Inherited — keys flowing down from an ancestor marked
          is_inheritable=true. Read-only for v1: clicking through to the
          source node lets the user edit it there. Local override should
          happen by adding the same key above. */}
      {inherited.length > 0 && (
        <section className="attr-panel-section attr-panel-inherited">
          <header className="attr-panel-section-label">{t("From parent")}</header>
          <ul className="attr-panel-list">
            {inherited.map((a) => (
              <li key={a.key} className="attr-row attr-row--inherited">
                <span className="attr-key" title={a.key}>{a.key}</span>
                <span className="attr-value attr-value--inherited">
                  {a.value || <em>{t("empty")}</em>}
                  <span className="attr-inherited-source" title={t("Comes from {source}", { source: a.source_node_title })}>
                    {" "}{t("from {source}", { source: a.source_node_title })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      </section>
      )}

    </div>
  );
}

/** Per tag, the fields its card shows — the fields a note with it gets
 *  (tagFields: its own plus inherited ones, which keep `inherited_from`) —
 *  minus the ones an earlier tag already shows, each with the later tags
 *  that define the same name. */
function tagCards(tags: readonly Tag[]): Array<{ tag: Tag; fields: Array<{ field: TagField; alsoUsedBy: Tag[] }> }> {
  const shown = new Set<string>();
  return tags.map((tag, i) => ({
    tag,
    fields: tagFields(tag).flatMap((field) => {
      if (shown.has(field.name)) return [];
      shown.add(field.name);
      const alsoUsedBy = tags.slice(i + 1).filter((other) => tagFields(other).some((f) => f.name === field.name));
      return [{ field, alsoUsedBy }];
    }),
  }));
}

/** Whether `attrs` (a note's property map) holds any the panel shows: not a
 *  system-reserved (`_`) or editor-internal key. */
export function hasShownAttributes(attrs: Record<string, string> | undefined): boolean {
  return Object.keys(attrs ?? {}).some((key) => !key.startsWith("_") && !INTERNAL_ATTRIBUTE_KEYS.has(key));
}
