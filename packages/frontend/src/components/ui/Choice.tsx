import type { LucideIcon } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { classNames } from "../../lib/utils";
import { isImeComposing } from "../../lib/keys";
import { stepRadio } from "../../lib/listNav";
import { Pressable } from "./Pressable";
import "./Choice.css";

// How a setting is shown rather than described (docs/agents/decisions-ui.md, 設定改版):
// the choices look like their result.
//   <ChoiceCards label="Theme" value={v} onChange={set} options={[{ value, label, sample: <i/> }]} />
//   <Segmented label="UI size" value={v} onChange={set} options={[{ value, label }]} />
//   <PreviewBlock label="Preview">…one preview for the page…</PreviewBlock>
// ChoiceCards is for up to five options that have a picture (a colour block, a word written in
// its own face, an icon); Segmented for up to five that are words. A longer list is a Select.

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  /** What the choice looks like: drawn above the label, and aria-hidden. */
  sample?: ReactNode;
  /** A CSS font-family list to write the sample in (a face of its own). */
  sampleFont?: string;
  /** Segmented only: draw this icon instead of the label, which then names the segment and is its tooltip. */
  Icon?: LucideIcon;
};

type ChoiceProps<T extends string> = {
  /** Accessible name of the group (already translated). */
  label: string;
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
  className?: string;
};

/** Arrow keys move through a radio group and choose, as the radio pattern asks; only the chosen one is in the tab order. */
function moveChoice(event: KeyboardEvent<HTMLDivElement>) {
  if (isImeComposing(event)) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const at = radios.indexOf(event.target as HTMLElement);
  const to = at < 0 ? null : stepRadio(event.key, at, radios.length);
  if (to === null) return;
  event.preventDefault();
  radios[to]!.focus();
  radios[to]!.click();
}

export function ChoiceCards<T extends string>({ label, value, options, onChange, className }: ChoiceProps<T>) {
  return (
    <div className={classNames("ui-choice-cards", className)} role="radiogroup" aria-label={label} onKeyDown={moveChoice}>
      {options.map((o) => (
        <Pressable key={o.value} role="radio" aria-checked={value === o.value} tabIndex={value === o.value ? 0 : -1} className="ui-choice-card"
          data-value={o.value} onClick={() => onChange(o.value)}>
          {o.sample !== undefined && <span className="ui-choice-sample" aria-hidden="true" style={o.sampleFont ? { "--choice-sample-font": o.sampleFont } as CSSProperties : undefined}>{o.sample}</span>}
          <span className="ui-choice-label">{o.label}</span>
        </Pressable>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, className }: ChoiceProps<T>) {
  return (
    <div className={classNames("ui-segmented", className)} role="radiogroup" aria-label={label} onKeyDown={moveChoice}>
      {options.map((o) => (
        <Pressable key={o.value} role="radio" aria-checked={value === o.value} tabIndex={value === o.value ? 0 : -1}
          className={classNames("ui-segment", o.Icon && "ui-segment--icon")} data-value={o.value} onClick={() => onChange(o.value)}
          {...(o.Icon ? { "aria-label": o.label, title: o.label } : {})}>
          {o.Icon ? <o.Icon size={18} aria-hidden="true" /> : o.label}
        </Pressable>
      ))}
    </div>
  );
}

/** The page's one preview: a framed area that reads the same variables the real screen reads. */
export function PreviewBlock({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div className={classNames("ui-preview-block", className)} role="img" aria-label={label}>{children}</div>;
}
