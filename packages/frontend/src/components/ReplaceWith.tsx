import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useDismiss } from "../hooks/useEscapeKey";
import { stepActive } from "../lib/listNav";
import { useT } from "../lib/i18n";
import { classNames } from "../lib/utils";
import { Button, Pressable, Sheet } from "./ui";
import "./ReplaceWith.css";

// 「換成…」: pick what the thing in front of you should become, and SEE it on the thing itself before anything is
// saved. The caller draws the real content in the real place (a slide's big picture, a block on a page); this
// panel only lists the choices and tells the caller which one is being previewed.
//
//   {open && (
//     <ReplaceWith title={t("Change to…")} applyLabel={t("Apply")} mobile={mobile}
//       options={layouts.map((l) => ({ id: l.id, label: t(l.label), hint: t(l.blurb), thumb: <MiniSlide … /> }))}
//       current={layout} onPreview={(id) => setPreview(id)} onApply={(id) => save(id)} onClose={() => setOpen(false)} />
//   )}
//   …draw `preview ?? current` where the content is.
//
// Hovering (a mouse), focusing (Tab, arrows) or tapping an option previews it (a tap is also a click); the last one shown stays shown until
// another is, so the pointer can travel to 「套用」 without the preview going away. 「套用」 saves it; 取消 or closing
// puts the content back (onPreview(null)). On a desktop the panel sits in the page beside the content (the caller
// places it); on a phone it is a bottom sheet short enough to leave the content visible above it.

export type ReplaceOption = {
  id: string;
  label: string;
  /** One plain sentence under the name. */
  hint?: string;
  /** A small picture of the result, as an index of the choices (not the way to choose: the preview is). */
  thumb?: ReactNode;
};

type Props = {
  title: string;
  applyLabel: string;
  options: readonly ReplaceOption[];
  /** The id in effect now. */
  current: string;
  /** The id being previewed, or null when it is back to what is in effect. */
  onPreview: (id: string | null) => void;
  onApply: (id: string) => void;
  onClose: () => void;
  mobile: boolean;
  className?: string;
};

export function ReplaceWith({ title, applyLabel, options, current, onPreview, onApply, onClose, mobile, className }: Props) {
  const t = useT();
  const [shown, setShown] = useState(current);
  const list = useRef<HTMLDivElement>(null);
  const preview = useRef(onPreview);
  preview.current = onPreview;
  useEffect(() => { preview.current(shown === current ? null : shown); }, [shown, current]);
  useEffect(() => () => preview.current(null), []);

  // A phone's sheet closes itself on Esc (ui/Sheet); beside the content the panel is not a dialog, so Esc and Back are asked for here.
  useDismiss(() => { onClose(); }, !mobile);

  const index = Math.max(0, options.findIndex((option) => option.id === shown));
  function onKey(e: KeyboardEvent) {
    const next = stepActive(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    list.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  }

  const body = (
    <div className={classNames("ui-replace", mobile && "ui-replace--sheet", className)} role={mobile ? undefined : "group"} aria-label={mobile ? undefined : title}>
      <h2 className="ui-replace-title">{title}</h2>
      <div ref={list} className="ui-replace-list" role="radiogroup" aria-label={title} onKeyDown={onKey}>
        {options.map((option) => (
          <Pressable key={option.id} role="radio" aria-checked={option.id === shown} title={option.hint}
            className={classNames("ui-replace-item", option.id === shown && "is-shown")}
            onMouseEnter={() => setShown(option.id)}
            onFocus={() => setShown(option.id)} onClick={() => setShown(option.id)}>
            {option.thumb && <span className="ui-replace-thumb" aria-hidden="true" inert>{option.thumb}</span>}
            <span className="ui-replace-name">
              {option.label}
              {option.id === current && <Check size={14} aria-hidden="true" />}
            </span>
          </Pressable>
        ))}
      </div>
      <div className="ui-replace-actions">
        <Button size="sm" onClick={onClose}>{t("Cancel")}</Button>
        <Button size="sm" variant="primary" disabled={shown === current} onClick={() => onApply(shown)}>{applyLabel}</Button>
      </div>
    </div>
  );
  return mobile ? <Sheet label={title} className="ui-replace-layer" desktop="bottom" onClose={onClose}>{body}</Sheet> : body;
}
