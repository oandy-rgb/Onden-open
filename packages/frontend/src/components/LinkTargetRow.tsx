import { useT } from "../lib/i18n";
import type { LinkTargetRow as Row } from "../lib/wikilinkTargets";
import { SnippetText } from "./SnippetText";
import { Pressable } from "./ui";

/** The small mark before a row: H1–H6 for a heading, • for a list item, ¶ for a paragraph. */
export function TargetIcon({ target }: { target: Row["target"] }) {
  return (
    <span className="slash-menu-icon slash-menu-icon--brackets" aria-hidden="true">
      {target.kind === "heading" ? `H${target.depth}` : target.blockKind === "listItem" ? "•" : "¶"}
    </span>
  );
}

/** One row of the `[[Note#` popup: a heading or a paragraph of the note, under
 *  a "Headings" / "Paragraphs" label where its kind starts. The row is the
 *  editor popup's own button (44px tall on touch screens, global.css), picked
 *  by the same mousedown the other rows use, so a tap keeps the editor focused. */
export function LinkTargetRow({ row, active, firstOfKind, onPick, onHover }: {
  row: Row; active: boolean; firstOfKind: boolean; onPick: () => void; onHover: () => void;
}) {
  const t = useT();
  const target = row.target;
  const label = target.kind === "heading" ? target.text : target.label;
  return (
    <>
      {firstOfKind && (
        <div className="slash-menu-group" role="presentation">{target.kind === "heading" ? t("Headings") : t("Paragraphs")}</div>
      )}
      <Pressable type="button" className={`slash-menu-item slash-menu-item--target${active ? " active" : ""}`}
        onMouseDown={() => onPick()}
        onMouseEnter={onHover}>
        <TargetIcon target={target} />
        <span className="slash-menu-title slash-menu-title--target">
          <SnippetText snippet={{ text: label, ranges: row.ranges }} markClassName="search-hl" />
        </span>
      </Pressable>
    </>
  );
}
