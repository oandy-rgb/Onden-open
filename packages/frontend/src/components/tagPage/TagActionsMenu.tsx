import { useState } from "react";
import { CornerDownRight, Download, Eye, EyeOff, Merge, MoreHorizontal, Trash2 } from "lucide-react";
import type { Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Pressable, usePopover } from "../ui";
import { exportTagPack } from "../TagsPanel";
import type { TagHide } from "./useTagHide";

/** The ⋯ menu by the title: the rarer actions — move under another tag,
 *  merge, hide, delete, and export. It only starts them; `onMove` / `onMerge`
 *  / `onDelete` open the panels that ask or confirm. `onMove` is left out when
 *  the person may not change the tag's place or the tag has none (a function's
 *  tag). */
export default function TagActionsMenu({ tag, hide, mergeDisabled, onMove, onMerge, onDelete }: {
  tag: Tag; hide: TagHide; mergeDisabled: boolean; onMove?: () => void; onMerge: () => void; onDelete: () => void;
}) {
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenu = usePopover<HTMLButtonElement>({ open: moreOpen, onClose: () => setMoreOpen(false), placement: "bottom-end" });
  const { hidden, canHide, reserved, locked, setHidden } = hide;
  return (
    <>
      <Pressable
        ref={moreMenu.anchor}
        type="button"
        className="schema-lens-icon-btn"
        aria-label={t("Tag actions")}
        title={t("Tag actions")}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((open) => !open)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </Pressable>
      {moreOpen && (
        <Menu popover={moreMenu} label={t("Tag actions")}>
          {onMove && (
            <MenuItem onSelect={onMove}><CornerDownRight size={14} aria-hidden="true" /> {t("Move under another tag…")}</MenuItem>
          )}
          <MenuItem onSelect={() => void exportTagPack(tag)} title={t("Download this tag as a portable .tagpack.json file")}>
            <Download size={14} aria-hidden="true" /> {t("Export tag")}
          </MenuItem>
          {canHide && (
            <MenuItem onSelect={() => setHidden(!hidden)}
              title={t(hidden ? "List this tag again in tag lists, chips and suggestions" : "Leave this tag out of tag lists, chips, suggestions and the website — it keeps working")}>
              {hidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />} {t(hidden ? "Unhide tag" : "Hide tag")}
            </MenuItem>
          )}
          {reserved ? (
            <MenuLabel>{t("System tag — it can be renamed but not merged or deleted.")}</MenuLabel>
          ) : locked ? (
            <MenuLabel>{t("Built-in function tag — it can be renamed, but not deleted or merged while that function is on.")}</MenuLabel>
          ) : (<>
            <MenuItem disabled={mergeDisabled} title={t("Fold this tag into another — shows what changes first")} onSelect={onMerge}>
              <Merge size={14} aria-hidden="true" /> {t("Merge into…")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger title={t("Delete this tag — shows what it affects first")} onSelect={onDelete}>
              <Trash2 size={14} aria-hidden="true" /> {t("Delete tag")}
            </MenuItem>
          </>)}
        </Menu>
      )}
    </>
  );
}
