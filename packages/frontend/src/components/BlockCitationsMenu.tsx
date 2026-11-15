import { FileText } from "lucide-react";
import { tn, useT } from "../lib/i18n";
import { displayTitle } from "../lib/noteLabel";
import { citationCount } from "../lib/blockSafety";
import { Menu, MenuHeading, MenuItem, usePopover } from "./ui";
import type { BlockCitationRow } from "@onden/contract";

/** The list a tap on 「被引用 N 次」 opens: the notes that cite the paragraph (only those the
 *  reader can see). A row opens that note; `onPick` also scrolls to the citation. */
export default function BlockCitationsMenu({ rows, anchor, onPick, onClose }: {
  rows: readonly BlockCitationRow[];
  anchor: HTMLElement;
  onPick: (row: BlockCitationRow) => void;
  onClose: () => void;
}) {
  const t = useT();
  const pop = usePopover<HTMLElement>({ open: true, onClose, placement: "bottom-end" });
  pop.anchor.current = anchor;
  const n = citationCount(rows);
  return (
    <Menu popover={pop} label={t("Notes that cite this paragraph")}>
      <MenuHeading>{tn("Cited here once", "Cited here {n} times", n)}</MenuHeading>
      {rows.map((row) => (
        <MenuItem key={row.source_id} onSelect={() => onPick(row)}>
          <FileText size={16} />{displayTitle(row.source_title)}{row.uses > 1 ? ` ×${row.uses}` : ""}
        </MenuItem>
      ))}
    </Menu>
  );
}
