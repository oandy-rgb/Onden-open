import { useT } from "../../lib/i18n";
import { Popover, type PopoverState } from "../ui";
import { LayoutChooser } from "../collections";
import type { AddViewSource } from "./useAddView";

// The panel behind 「＋」 in the tab row: the ways of seeing the page —
// table, calendar, board, cards, and the whiteboard when that module is on.
// What is listed and what choosing does is `AddViewSource` (useAddView), the
// same the note's ⋯ › 檢視 uses; the choice and the field it asks for are the
// collections' LayoutChooser, the same step 「⚙」 shows when a view's layout
// is changed. The whiteboard and the table are added at once; the others first
// ask for the one field they need, and the answer is stored on the view.

type Props = {
  popover: PopoverState<HTMLElement>;
  source: AddViewSource;
  /** The tag's fields can be edited here (the person may change the tag). */
  onEditFields?: () => void;
  onClose: () => void;
};

export default function AddViewPanel({ popover, source, onEditFields, onClose }: Props) {
  const t = useT();
  return (
    <Popover popover={popover} className="cv-add-view-panel" label={t("Add a view")}>
      <LayoutChooser
        choices={source.choices} fields={source.fields} ownerKind={source.ownerKind} busy={source.busy} submitLabel={t("Add view")}
        onChoose={(picked, chosen) => { onClose(); void source.add(picked, chosen); }}
        onEditFields={onEditFields && (() => { onClose(); onEditFields(); })}
      />
    </Popover>
  );
}
