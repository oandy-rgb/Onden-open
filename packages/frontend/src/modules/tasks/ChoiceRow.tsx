// One setting as a line: its name, what is set (grey `unset` while nothing is) and,
// when open, its choices under it. The task's settings sheet and the focus start sheet
// both use it, so a setting looks and behaves the same wherever it sits.

import { ChevronDown, ChevronRight } from "lucide-react";
import { Pressable } from "../../components/ui";
import { classNames } from "../../lib/utils";
import "./ChoiceRow.css";

export function ChoiceRow({ label, value, unset, open, onToggle, children }: { label: string; value: string | null; unset: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="setting-row" role="group" aria-label={label}>
      <Pressable type="button" className="setting-row-head" aria-expanded={open} onClick={onToggle}>
        <span className="setting-row-label">{label}</span>
        <span className={classNames("setting-row-value", value && "is-set")}>{value ?? unset}</span>
        <Chevron size={18} aria-hidden />
      </Pressable>
      {open && <div className="setting-row-body">{children}</div>}
    </div>
  );
}
