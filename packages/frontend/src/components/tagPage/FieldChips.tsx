import { useState, type DragEvent, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import type { Tag } from "../../lib/api";
import { addToast } from "../../lib/appStore";
import { useT, tn } from "../../lib/i18n";
import { withPromotedField } from "../../lib/tagFieldEdits";
import { namesTakenAround } from "../../lib/tagFields";
import { isImeComposing } from "../../lib/keys";
import { pointBelow, requestFieldEditor } from "../../lib/tagFieldRequest";
import type { FieldDef } from "../TagsPanel";
import { Pressable } from "../ui";
import type { FieldModel } from "./fieldModel";
import type { TagTreeModel } from "./tagTreeModel";
import type { useSchemaDraft } from "./structure/useSchemaDraft";

const keyOf = (f: FieldDef) => f.name || f.key || "";

/** 「欄位」: one small chip per field under the title (type, then name) and
 *  「＋ 欄位」. A chip opens that field's settings (FieldPopover) and, for the
 *  owner, can be dragged to change the order (Alt + ← / → on the keyboard).
 *  Inherited fields are listed plainly, marked with the tag they come from.
 *  Properties the notes already use can be made fields from the last line. */
export default function FieldChips({ tag, draft, fieldModel, tree, canManage }: {
  tag: Tag;
  draft: Pick<ReturnType<typeof useSchemaDraft>, "fields" | "setFields" | "save" | "flush">;
  fieldModel: Pick<FieldModel, "inheritedFields" | "promotable" | "clashesOf" | "fieldClashes">;
  tree: Pick<TagTreeModel, "tagById" | "tagsWithSelf">;
  canManage: boolean;
}) {
  const t = useT();
  const { fields, setFields, save, flush } = draft;
  const { inheritedFields, promotable, clashesOf, fieldClashes } = fieldModel;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  if (!canManage && fields.length === 0 && inheritedFields.length === 0) return null;

  /** Save a new order (or a promoted field); a field held back by a same-name clash stays out of the save. */
  const commit = (next: FieldDef[]) => {
    setFields(next);
    const held = clashesOf(next);
    save({ fields: next.filter((f) => !held.has(keyOf(f))) });
    void flush();
  };
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= fields.length) return;
    const next = fields.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    commit(next);
  };
  const open = (target: string | number | null, el: Element) => requestFieldEditor({ tagId: tag.id, field: target, at: pointBelow(el) });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (isImeComposing(event) || !event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    move(index, index + (event.key === "ArrowLeft" ? -1 : 1));
  };
  const onDrop = (event: DragEvent<HTMLElement>, to: number) => {
    event.preventDefault();
    if (dragIndex !== null) move(dragIndex, to);
    setDragIndex(null);
    setOverIndex(null);
  };

  /** 「加成欄位」: make a property the notes already use a field of this tag (the type is inferred from a value they hold). */
  function promoteProperty(key: string, sampleValue: string) {
    // The one same-name rule (lib/tagFields): a name a tag above or a function already gives, or a tag below declares, is not declared again.
    if (namesTakenAround(tag, tree.tagsWithSelf).includes(key)) {
      addToast(t("A tag above already has a field with this name. Rename it first."), "error");
      return;
    }
    const next = withPromotedField(fields, key, sampleValue);
    if (next) commit(next);
  }

  return (
    <div className="tag-page-row" role="group" aria-label={t("Fields")}>
      <span className="tag-page-row-label">{t("Fields")}</span>
      <div className="tag-page-items">
        {fields.map((f, index) => {
          const name = f.label || keyOf(f) || t("New field");
          const clash = fieldClashes.has(keyOf(f));
          const chip = (
            <>
              <span className="tag-field-type">{t((f as { rollup?: unknown }).rollup ? "Calculated (auto-total)" : f.type)}</span>{name}
            </>
          );
          const className = `tag-field-item${clash ? " is-clash" : ""}${overIndex === index && dragIndex !== null && dragIndex !== index ? " is-over" : ""}${dragIndex === index ? " is-dragging" : ""}`;
          return canManage ? (
            <Pressable key={index} type="button" className={className} data-field={keyOf(f)}
              draggable onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(event) => { if (dragIndex !== null) { event.preventDefault(); setOverIndex(index); } }}
              onDrop={(event) => onDrop(event, index)}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
              onKeyDown={(event) => onKeyDown(event, index)}
              aria-haspopup="dialog" title={clash ? t("Another tag already has a field with this name") : t("Drag to change the order")}
              onClick={(event) => open(index, event.currentTarget)}>{chip}</Pressable>
          ) : <span key={index} className={className}>{chip}</span>;
        })}
        {inheritedFields.map((field) => {
          const from = tree.tagById.get(field.inherited_from!)?.name;
          return (
            <span key={field.name} className="tag-field-item is-inherited" title={from ? t("from #{name}", { name: from }) : undefined}>
              <span className="tag-field-type">{t(field.type)}</span>{field.label || field.name}
            </span>
          );
        })}
        {canManage && (
          <Pressable type="button" className="tag-field-add" onClick={(event) => open(null, event.currentTarget)}>
            <Plus size={13} aria-hidden="true" />{t("Add field")}
          </Pressable>
        )}
      </div>
      {canManage && promotable.length > 0 && (
        <div className="tag-promote" role="group" aria-label={t("Make into a field")}>
          <span className="tag-page-row-label">{t("In use")}</span>
          <div className="tag-page-items">
            {promotable.map(({ key, notes, sample }) => (
              <Pressable key={key} type="button" className="tag-field-add" title={tn("1 note", "{n} notes", notes)}
                aria-label={t("Make “{key}” a field of #{name}", { key, name: tag.name })} onClick={() => promoteProperty(key, sample)}>
                <Plus size={13} aria-hidden="true" />{key}
              </Pressable>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
