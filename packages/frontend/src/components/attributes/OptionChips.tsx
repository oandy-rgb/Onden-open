// A select field's value as chips: every option is on screen and one tap picks
// it (the current one has the theme-colour frame). Too many options for a row
// fall back to the dropdown (SchemaRow's SelectValue draws that).

import { classNames } from "../../lib/utils";
import { Pressable } from "../ui";

/** Whether the options fit as chips: a few, and short (a CJK character counts double). */
export function fitsAsChips(options: readonly string[]): boolean {
  const width = options.reduce((sum, opt) => sum + [...opt].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0) + 3, 0);
  return options.length <= 6 && width <= 40;
}

export function OptionChips({ label, options, value, disabled, onPick, trailing }: {
  label: string;
  options: readonly string[];
  value: string;
  disabled?: boolean;
  /** "" clears: picking the chosen option again unsets it. */
  onPick: (next: string) => void;
  /** After the chips: the owner's 「＋ 新增選項」. */
  trailing?: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="attr-choices">
      {options.map((opt) => (
        <Pressable key={opt} className={classNames("attr-choice", opt === value && "attr-choice--on")} aria-pressed={opt === value}
          disabled={disabled} onClick={() => onPick(opt === value ? "" : opt)}>
          {opt}
        </Pressable>
      ))}
      {trailing}
    </div>
  );
}
