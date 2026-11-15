import { useState, type ReactNode } from "react";
import { ChevronDown, Layers, X } from "lucide-react";
import { Button, Menu, MenuItem, usePopover } from "./ui";
import { useT } from "../lib/i18n";
import { spaceLabel, type Space } from "../lib/spaces";
import type { PhoneTopbarAction } from "../lib/phoneTopbarActions";
import "./SpaceFilter.css";

// 「全部空間 ▾」 for a page that can be narrowed to one space (tasks, history). Only offered with
// two or more spaces; the page owns the choice and passes it in.
//
//   computer: <SpaceFilterButton {...filter} />            a button in the page's own title row
//   phone:    const spaceAction = usePhoneSpaceFilter(filter)  → usePhoneTopbarActions([..., spaceAction.action])
//             render spaceAction.menu and <SpaceFilterNote {...filter} /> (「只看：○○ ✕」) above the list
//
// A phone page has no title row, so the filter is a top-bar icon (lib/phoneTopbarActions) and takes no
// height until a space is chosen; then the note says the list is narrowed, one tap clears it.

export type SpaceFilterProps = {
  spaces: readonly Space[];
  /** The chosen space; null = all. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** The menu's accessible name: what is narrowed (「只看某個空間的任務」). */
  menuLabel: string;
};

function SpaceMenu({ spaces, value, onChange, menuLabel, popover }: SpaceFilterProps & { popover: ReturnType<typeof usePopover> }) {
  const t = useT();
  return (
    <Menu popover={popover} label={menuLabel}>
      <MenuItem checked={value === null} onSelect={() => onChange(null)}>{t("All spaces")}</MenuItem>
      {spaces.map((s) => <MenuItem key={s.id} checked={value === s.id} onSelect={() => onChange(s.id)}>{spaceLabel(s)}</MenuItem>)}
    </Menu>
  );
}

/** Computer: a button showing the current choice, in the page's own title row. */
export function SpaceFilterButton(props: SpaceFilterProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  const current = props.spaces.find((s) => s.id === props.value);
  return (
    <>
      <Button ref={pop.anchor} variant="ghost" size="sm" className="space-filter" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{current ? spaceLabel(current) : t("All spaces")}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {open && <SpaceMenu {...props} popover={pop} />}
    </>
  );
}

/** Phone: the top-bar action that opens the menu at the button, and the menu to render. */
export function usePhoneSpaceFilter(props: SpaceFilterProps): { action: PhoneTopbarAction | null; menu: ReactNode } {
  const t = useT();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const pop = usePopover({ open: at !== null, onClose: () => setAt(null), placement: "bottom-end", at: at ?? undefined });
  if (props.spaces.length < 2) return { action: null, menu: null };
  return {
    action: {
      id: "space-filter",
      label: t("Filter by space"),
      Icon: Layers,
      marked: props.value !== null,
      onSelect: (button) => { const r = button.getBoundingClientRect(); setAt({ x: r.right, y: r.bottom + 6 }); },
    },
    menu: at && <SpaceMenu {...props} popover={pop} />,
  };
}

/** 「只看：○○ ✕」: shown only while a space is chosen; a tap shows every space again. */
export function SpaceFilterNote({ spaces, value, onChange }: Omit<SpaceFilterProps, "menuLabel">) {
  const t = useT();
  const current = spaces.find((s) => s.id === value);
  if (!current) return null;
  const name = spaceLabel(current);
  return (
    <div className="space-filter-note" role="status">
      <Button variant="ghost" size="sm" className="space-filter-note-clear" onClick={() => onChange(null)}
        aria-label={t("Show every space again (now only {name})", { name })}>
        <span>{t("Only: {name}", { name })}</span><X size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}
