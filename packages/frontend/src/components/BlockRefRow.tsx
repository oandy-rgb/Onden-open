import { useT } from "../lib/i18n";
import type { BlockRefRow as Row } from "../lib/blockRefSearch";
import { TargetIcon } from "./LinkTargetRow";
import { SnippetText } from "./SnippetText";
import { displayTitle } from "../lib/noteLabel";
import { Pressable } from "./ui";

/** One row of the `((` popup (and 「最近存的段落」 in the `[[` popup): the
 *  words of a paragraph or heading, matching words marked, with the note it
 *  belongs to beside them. A label starts each run of recent / found rows. The
 *  row is the editor popup's own button, picked by the same mousedown the
 *  other rows use, so a tap keeps the editor focused. */
export function BlockRefRow({ row, active, firstOfOrigin, onPick, onHover }: {
  row: Row; active: boolean; firstOfOrigin: boolean; onPick: () => void; onHover: () => void;
}) {
  const t = useT();
  return (
    <>
      {firstOfOrigin && (
        <div className="slash-menu-group" role="presentation">{row.origin === "recent" ? t("Recently saved paragraphs") : t("Paragraphs and headings")}</div>
      )}
      <Pressable type="button" className={`slash-menu-item slash-menu-item--target slash-menu-item--block-ref${active ? " active" : ""}`}
        onMouseDown={() => onPick()}
        onMouseEnter={onHover}>
        <TargetIcon target={row.target} />
        <span className="slash-menu-title slash-menu-title--target">
          <SnippetText snippet={row.snippet} markClassName="search-hl" />
        </span>
        <span className="slash-menu-source">{displayTitle(row.noteTitle)}</span>
      </Pressable>
    </>
  );
}
