import { useState } from "react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { FieldDef } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { VIEW_MODULES, type ViewModuleSpec } from "../../modules";
import type { ViewChanges } from "../../lib/data";
import { paramOptions } from "./paramOptions";
import { Pressable, Select } from "../ui";
import "./LayoutChooser.css";

// The one place a view's layout is chosen: the list of layouts, then (for a
// calendar, board or cards) the one field it needs. Both 「＋」 (a new view)
// and 「⚙」 (changing the open view's layout) show this and store the answer
// with `placementChanges`, so the two cannot ask different questions.

export type LayoutParam = NonNullable<ViewModuleSpec["param"]>;
/** `present`: the page already has a tab of this kind, so choosing it goes there instead of adding. */
export type LayoutChoice = { layout: string; title: string; Icon: LucideIcon; param?: LayoutParam; present?: boolean };

/** Every view layout the workspace has, as choices (the module's library title and icon). */
export function layoutChoices(): LayoutChoice[] {
  return VIEW_MODULES.map((mod) => ({ layout: mod.id, title: mod.library.title, Icon: mod.library.Icon, param: mod.view.param }));
}

/** What to add when the page has no field of the kind a view is placed by,
 *  in plain words; null when the view needs none (the table, the cards). */
export function missingFieldHint(param: LayoutParam, ownerKind: "tag" | "node"): string | null {
  if (param.optional) return null;
  if (param.key === "date_field") {
    return "There is no date field yet. Use Created date or Last edited date, or add a Date field first.";
  }
  return ownerKind === "tag"
    ? "A board needs a field to split into columns. Add a Select field (for example “Status”) to this tag, then come back."
    : "A board needs a field to split into columns. Give the sub-notes a tag that has a Select field (for example “Status”), then come back.";
}

/** The changes that place a view by `field` (the board's columns live on
 *  `group_by`, the others in `layout_config`); an empty field is 「automatic」.
 *  The field is also added to `visible_fields` when it is not there, so the
 *  view shows it as a column (the server fills a placement field either way —
 *  collectionViewQuery placementFields). Every place that sets one — the board,
 *  the calendar, the group picker in ViewBuilder — goes through here. */
export function placementChanges(
  param: Pick<LayoutParam, "key">,
  field: string,
  current: { layout_config?: Record<string, unknown> | null; visible_fields: readonly string[] },
): Pick<ViewChanges, "group_by" | "layout_config" | "visible_fields"> {
  const changes: Pick<ViewChanges, "group_by" | "layout_config" | "visible_fields"> = {};
  if (param.key === "group_by") changes.group_by = field || null;
  else {
    const config = { ...current.layout_config };
    if (field) config[param.key] = field;
    else delete config[param.key];
    changes.layout_config = config;
  }
  if (field && !current.visible_fields.includes(field)) changes.visible_fields = [...current.visible_fields, field];
  return changes;
}

type Props = {
  choices: LayoutChoice[];
  /** The fields of the page's tag, or the ones its sub-notes share. */
  fields: FieldDef[];
  /** What the fields belong to: a tag's page names the tag, a note's names its sub-notes. */
  ownerKind: "tag" | "node";
  busy: boolean;
  /** The label of the button that takes the field. */
  submitLabel: string;
  /** Open on this layout's field question instead of the list. */
  initial?: LayoutChoice;
  /** The field step's way back; without it, back returns to the list. */
  onBack?: () => void;
  /** The layout and the field chosen for it ("" when it takes none or is automatic). */
  onChoose: (choice: LayoutChoice, field: string) => void;
  /** A tag's fields can be edited here (the person may change the tag). */
  onEditFields?: () => void;
  /** A board with nothing to split by can be given one right here: adds a 「狀態」 select field to the tag and returns its
   *  name (null: it was not added, and the writer said why). Only a tag's page has it. */
  onAddStatusField?: () => Promise<string | null>;
};

export default function LayoutChooser({ choices, fields, ownerKind, busy, submitLabel, initial, onBack, onChoose, onEditFields, onAddStatusField }: Props) {
  const t = useT();
  const options = (param: LayoutParam) =>
    paramOptions(param, fields).map((o) => (o.builtIn ? { ...o, label: t(o.label) } : o));
  const start = (next: LayoutChoice) => (next.param?.optional ? "" : options(next.param!)[0]?.key ?? "");
  const [choice, setChoice] = useState<LayoutChoice | null>(initial ?? null);
  const [field, setField] = useState(initial?.param ? start(initial) : "");

  // Choosing from the list only asks when there is no answer to give: a calendar with a date to use, cards that
  // pick their own cover and a board with a select field already have one, so the view is made at once and the
  // field is changed later in the view's settings.
  function pick(next: LayoutChoice) {
    const first = next.param && !next.present ? start(next) : "";
    if (!next.param || next.present || first || next.param.optional) { onChoose(next, first); return; }
    setChoice(next);
    setField(first);
  }
  const addStatusField = async () => {
    const name = await onAddStatusField?.();
    if (name && choice) onChoose(choice, name);
  };

  if (!choice) {
    return (
      <ul className="cv-add-view-list">
        {choices.map((option) => (
          <li key={option.layout}>
            <Pressable type="button" className="cv-add-view-option" disabled={busy} onClick={() => pick(option)}>
              <option.Icon size={15} aria-hidden="true" />{t(option.title)}
              {option.present && <span className="cv-add-view-have">{t("Already here")}</span>}
            </Pressable>
          </li>
        ))}
      </ul>
    );
  }
  const param = choice.param!;
  const choiceOptions = options(param);
  const hint = fields.some((f) => param.types.includes(f.type)) ? null : missingFieldHint(param, ownerKind);
  return (
    <form className="cv-add-view-form" onSubmit={(event) => { event.preventDefault(); onChoose(choice, field); }}>
      <Pressable type="button" className="cv-add-view-back" onClick={() => (onBack ? onBack() : setChoice(null))} aria-label={t("Back")}>
        <ArrowLeft size={14} aria-hidden="true" /><choice.Icon size={15} aria-hidden="true" />{t(choice.title)}
      </Pressable>
      {hint && <p className="cv-add-view-note" role="note">{t(hint)}</p>}
      {choiceOptions.length === 0 && !param.optional ? (
        <>
          {onAddStatusField && param.key === "group_by" && (
            <Pressable type="button" className="cv-add-view-create" disabled={busy} onClick={() => void addStatusField()}>{t("Add a “Status” field")}</Pressable>
          )}
          {onEditFields && <Pressable type="button" className="cv-add-view-back" onClick={onEditFields}>{t("Edit fields")}</Pressable>}
        </>
      ) : (
        <>
          <label className="cv-add-view-field">
            <span>{t(param.label)}</span>
            <Select value={field} onChange={(event) => setField(event.target.value)}>
              {param.optional && <option value="">{t("(automatic)")}</option>}
              {choiceOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </Select>
          </label>
          <Pressable type="submit" className="cv-add-view-create" disabled={busy || (!field && !param.optional)}>{submitLabel}</Pressable>
        </>
      )}
    </form>
  );
}
