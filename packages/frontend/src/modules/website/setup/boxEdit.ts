// What the website screen does to the boxes: replace what sits in one, add a slot to a
// list box, move one up or down, remove one. Pure — the limits and the one-class-per-box
// rule are the registry's (@onden/site), so a screen cannot save what validateDesign would change.
import { BOX_SPECS, WIDGETS, cleanPick, defaultVariantOf, isListBox, picksOf, widgetReady, withBox, type BoxId, type BoxPick, type SiteBoxes, type WidgetDef, type WidgetFacts } from "@onden/site";

/** One place on the page: a slot of a box. `index` = `picksOf(box).length` is the 「＋加一格」 of a list box. */
export type BoxTarget = { box: BoxId; index: number };

/** What the picker puts in a slot: a widget and its look, or `null` for 留空. */
export type Candidate = BoxPick | null;

export const targetPick = (boxes: SiteBoxes, { box, index }: BoxTarget): BoxPick | null => picksOf(boxes, box)[index] ?? null;

/** `boxes` with the slot holding `candidate`. Anything the box does not take, or past its limit, changes nothing. */
export function putInSlot(boxes: SiteBoxes, target: BoxTarget, candidate: Candidate): SiteBoxes {
  const { box, index } = target;
  const clean = candidate === null ? null : cleanPick(candidate, box);
  if (candidate !== null && clean === null) return boxes;
  if (!isListBox(box)) return withBox(boxes, box, clean);
  const list = [...picksOf(boxes, box)];
  if (index >= list.length) return clean && list.length < BOX_SPECS[box].max ? withBox(boxes, box, [...list, clean]) : boxes;
  if (clean === null) list.splice(index, 1);
  else list[index] = clean;
  return withBox(boxes, box, list);
}

export const removeSlot = (boxes: SiteBoxes, target: BoxTarget): SiteBoxes => putInSlot(boxes, target, null);

/** Move a slot of a list box one place up (`-1`) or down (`1`). */
export function moveSlot(boxes: SiteBoxes, { box, index }: BoxTarget, by: -1 | 1): SiteBoxes {
  const list = [...picksOf(boxes, box)];
  const to = index + by;
  if (!isListBox(box) || index < 0 || index >= list.length || to < 0 || to >= list.length) return boxes;
  [list[index], list[to]] = [list[to]!, list[index]!];
  return withBox(boxes, box, list);
}

export const canAddSlot = (boxes: SiteBoxes, box: BoxId): boolean => isListBox(box) && picksOf(boxes, box).length < BOX_SPECS[box].max;

/** The widgets the picker offers for a box, each with whether the site has what it needs. */
export function optionsFor(box: BoxId, facts: WidgetFacts): Array<{ widget: WidgetDef; ready: boolean }> {
  return WIDGETS.accepted(BOX_SPECS[box].accepts).map((widget) => ({ widget, ready: widgetReady(widget, facts) }));
}

/** The pick for choosing `widget` in a slot that holds `current`: the same look when it is the same widget, else its first. */
export function pickFor(widget: WidgetDef, current: BoxPick | null): BoxPick {
  return { widget: widget.id, variant: current?.widget === widget.id ? current.variant : defaultVariantOf(widget) };
}

export const samePick = (a: Candidate, b: Candidate): boolean => (a === null || b === null ? a === b : a.widget === b.widget && a.variant === b.variant);
