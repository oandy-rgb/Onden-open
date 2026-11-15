import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { useIsMobile } from "../../hooks/useIsMobile";
import { useT } from "../../lib/i18n";
import type { SpacePermission } from "@onden/contract";
import { Menu, MenuItem, MenuSeparator, usePopover, Pressable } from "../../components/ui";

/** A person's standing in one space: 不在 (not a member, reads nothing), 只能看 or 可編輯. */
export type Standing = "none" | SpacePermission;

export function useStandingLabel() {
  const t = useT();
  return (standing: Standing) => standing === "none" ? t("Not in") : standing === "view" ? t("View only") : t("Can edit");
}

/** One person's standing in one space as a menu: the two things they may do,
 *  each with what it means, and a way out. A change applies at once; the
 *  caller says what happened and offers 復原. Read-only (a member looking at
 *  someone else's standing) shows the answer as text instead of a control that
 *  would refuse. `leave` is how the way out reads: 「移出這個空間」 for a
 *  person already in, 「不加入」 in a form that has not added them yet. */
export default function PermissionControl({ label, name, value, readOnly = false, busy = false, leave = "move-out", onChange }: {
  /** Names the control for assistive tech: who, in which space. */
  label: string;
  /** Who it is about, for the sentence under 「移出」. */
  name: string;
  value: Standing;
  readOnly?: boolean;
  busy?: boolean;
  leave?: "move-out" | "skip";
  onChange: (next: Standing) => void;
}) {
  const t = useT();
  const standingLabel = useStandingLabel();
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const menu = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  const aria = t("{label}: {standing}", { label, standing: standingLabel(value) });
  if (readOnly) return <span className={`standing standing--${value}`} aria-label={aria}>{standingLabel(value)}</span>;
  const choose = (next: Standing) => () => { if (next !== value) onChange(next); };
  return (
    <>
      <Pressable ref={menu.anchor} className="standing-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={aria}
        disabled={busy} onClick={() => setOpen(!open)}>
        {standingLabel(value)} <ChevronDown size={13} aria-hidden="true" />
      </Pressable>
      {open && (
        <Menu popover={menu} label={label} className="standing-menu" sheet={phone}>
          <MenuItem checked={value === "edit"} onSelect={choose("edit")}>
            <span className="standing-menu-item"><strong>{t("Can edit")}</strong><small>{t("Add, change and delete the notes here")}</small></span>
          </MenuItem>
          <MenuItem checked={value === "view"} onSelect={choose("view")}>
            <span className="standing-menu-item"><strong>{t("View only")}</strong><small>{t("Can see the notes, but not change them")}</small></span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={choose("none")}>
            <span className="standing-menu-item">
              <strong>{leave === "move-out" ? t("Move out of this space") : t("Not in this space")}</strong>
              <small>{t("{name} won't see the notes here", { name })}</small>
            </span>
          </MenuItem>
        </Menu>
      )}
    </>
  );
}
