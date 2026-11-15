// 「換成…」: what a slot of the page can hold. Only the widgets that box takes are listed, each with
// its looks. Pointing at an option (hover, focus — and a tap on a phone) makes the page itself show
// that option in the slot; nothing is saved until 「套用」. 「留空」 empties a single box; a slot of a
// list box can also move up or down or be removed.
import { useEffect, useState } from "react";
import { BOX_SPECS, isListBox, type BoxPick, type SiteBoxes, type WidgetFacts } from "@onden/site";
import { Button, Pressable } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { siteWord } from "./siteWords";
import { moveSlot, optionsFor, pickFor, removeSlot, samePick, targetPick, type BoxTarget, type Candidate } from "./boxEdit";
import "./SiteSetup.css";

type Props = {
  target: BoxTarget;
  boxes: SiteBoxes;
  facts: WidgetFacts;
  /** What the page should show in the slot right now (`undefined`: the saved one). */
  onPreview: (candidate: Candidate | undefined) => void;
  onApply: (candidate: Candidate) => void;
  /** A list slot moved or removed: the whole new boxes. */
  onBoxes: (boxes: SiteBoxes) => void;
  onClose: () => void;
};

export default function ReplacePicker({ target, boxes, facts, onPreview, onApply, onBoxes, onClose }: Props) {
  const t = useT();
  const spec = BOX_SPECS[target.box];
  const current = targetPick(boxes, target);
  const adding = isListBox(target.box) && current === null;
  const [chosen, setChosen] = useState<Candidate | undefined>(undefined);
  const [hover, setHover] = useState<Candidate | undefined>(undefined);
  const shown = hover !== undefined ? hover : chosen;
  useEffect(() => { onPreview(shown); }, [shown, onPreview]);
  useEffect(() => () => onPreview(undefined), [onPreview]);

  const options = optionsFor(target.box, facts);
  const list = isListBox(target.box);
  const size = boxes[target.box] instanceof Array ? (boxes[target.box] as BoxPick[]).length : 0;
  const choose = (candidate: Candidate) => { setChosen(candidate); setHover(undefined); };
  const candidateDiffers = chosen !== undefined && !samePick(chosen, current);

  return (
    <div className="ss-picker" data-testid="replace-picker">
      <h2 className="ss-picker__title">{adding ? t("Add to “{box}”", { box: siteWord(spec.label) }) : t("Replace in “{box}” with…", { box: siteWord(spec.label) })}</h2>
      <ul className="ss-picker__list" role="list">
        {!list && !adding && (
          <li>
            <Pressable
              type="button" className="ss-option" aria-pressed={chosen === null || (chosen === undefined && current === null)}
              onMouseEnter={() => setHover(null)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(null)} onBlur={() => setHover(undefined)}
              onClick={() => choose(null)}
            >
              <span className="ss-option__name">{t("Leave empty")}</span>
            </Pressable>
          </li>
        )}
        {options.map(({ widget, ready }) => {
          const isCurrent = current?.widget === widget.id;
          const selected = chosen?.widget === widget.id || (chosen === undefined && isCurrent);
          const base = pickFor(widget, chosen === undefined ? current : chosen);
          return (
            <li key={widget.id} className="ss-option-row" data-selected={selected ? "" : undefined}>
              <Pressable
                type="button" className="ss-option" aria-pressed={selected} data-widget={widget.id}
                onMouseEnter={() => setHover(base)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(base)} onBlur={() => setHover(undefined)}
                onClick={() => choose(base)}
              >
                <span className="ss-option__name">{siteWord(widget.label)}</span>
                <span className="ss-option__blurb">{siteWord(widget.blurb)}</span>
                {!ready && widget.needs && <span className="ss-option__needs">{siteWord(widget.needs)}</span>}
              </Pressable>
              {selected && widget.variants.length > 1 && (
                <div className="ss-variants" role="group" aria-label={t("Look")}>
                  {widget.variants.map((variant) => {
                    const pick = { widget: widget.id, variant: variant.id };
                    const on = (chosen ?? current)?.variant === variant.id;
                    return (
                      <Pressable
                        key={variant.id} type="button" className="ss-variant" aria-pressed={on} data-variant={variant.id}
                        onMouseEnter={() => setHover(pick)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(pick)} onBlur={() => setHover(undefined)}
                        onClick={() => choose(pick)}
                      >{siteWord(variant.label)}</Pressable>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {list && !adding && (
        <div className="ss-picker__slot" role="group" aria-label={t("This slot")}>
          <Button size="sm" variant="ghost" disabled={target.index === 0} onClick={() => { onBoxes(moveSlot(boxes, target, -1)); onClose(); }}>{t("Move up")}</Button>
          <Button size="sm" variant="ghost" disabled={target.index >= size - 1} onClick={() => { onBoxes(moveSlot(boxes, target, 1)); onClose(); }}>{t("Move down")}</Button>
          <Button size="sm" variant="ghost" onClick={() => { onBoxes(removeSlot(boxes, target)); onClose(); }}>{t("Remove")}</Button>
        </div>
      )}
      <div className="ss-picker__actions">
        <Button variant="primary" disabled={!candidateDiffers} onClick={() => { if (chosen !== undefined) onApply(chosen); }}>{t("Apply")}</Button>
        <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
      </div>
    </div>
  );
}
