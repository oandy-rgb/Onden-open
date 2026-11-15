import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useT } from "../lib/i18n";
import { Button, Menu, MenuItem, MenuSeparator, usePopover } from "./ui";
import { openSettings } from "../lib/settingsRequest";

/** The "⋯" of every page toolbar (handwriting note, PDF): the finger switch
 *  (always there), the zoom items a host has, and — when the page can be edited
 *  — clearing everything. Clearing is the host's to confirm and carry out. The
 *  finger switch is the device's finger setting (lib/inkInputPrefs): on = a
 *  finger draws with the pen tool, off = it only scrolls. */
export default function PageMoreMenu({
  fingerDraws,
  onToggleFingerDraws,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onClearAll,
}: {
  fingerDraws: boolean;
  onToggleFingerDraws: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitWidth?: () => void;
  /** Absent when the page is read-only. */
  onClearAll?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  const hasZoom = onZoomIn !== undefined || onZoomOut !== undefined || onFitWidth !== undefined;
  return (
    <>
      <Button
        ref={pop.anchor}
        variant="ghost"
        size="sm"
        className="ink-tool-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("More")}
        title={t("More")}
        data-pdf-more
        onClick={() => setOpen((cur) => !cur)}
      ><MoreHorizontal size={15} /></Button>
      {open && (
        <Menu popover={pop} label={t("More")}>
          <MenuItem checked={fingerDraws} keepOpen data-ink-finger-draws={fingerDraws ? "on" : "off"} onSelect={onToggleFingerDraws}>
            {t("Finger draws too")}
          </MenuItem>
          <MenuItem onSelect={() => openSettings("handwriting")}>{t("Handwriting settings…")}</MenuItem>
          {hasZoom && <MenuSeparator />}
          {onZoomIn && <MenuItem onSelect={onZoomIn}>{t("Zoom in")}</MenuItem>}
          {onZoomOut && <MenuItem onSelect={onZoomOut}>{t("Zoom out")}</MenuItem>}
          {onFitWidth && <MenuItem onSelect={onFitWidth}>{t("Fit width")}</MenuItem>}
          {onClearAll && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={onClearAll}>{t("Clear all annotations")}</MenuItem>
            </>
          )}
        </Menu>
      )}
    </>
  );
}
