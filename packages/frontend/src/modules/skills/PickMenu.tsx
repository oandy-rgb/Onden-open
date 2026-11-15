import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Menu, MenuItem, MenuLabel, usePopover } from "../../components/ui";

export type PickOption = { key: string; label: string };

/** A small 「＋」 button that opens a list to pick one thing from (a tag to apply
 *  a skill to, a skill to add to a tag). `empty` says why the list is empty. */
export default function PickMenu({ label, options, empty, disabled, onPick }: {
  /** The button's text and the list's name, already translated. */
  label: string;
  options: readonly PickOption[];
  empty: string;
  disabled?: boolean;
  onPick: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popover = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  return (
    <>
      <Button ref={popover.anchor} size="sm" variant="ghost" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        <Plus size={14} aria-hidden="true" /> {label}
      </Button>
      {open && (
        <Menu popover={popover} label={label}>
          {options.length === 0 ? <MenuLabel>{empty}</MenuLabel> : options.map((option) => (
            <MenuItem key={option.key} onSelect={() => onPick(option.key)}>{option.label}</MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
