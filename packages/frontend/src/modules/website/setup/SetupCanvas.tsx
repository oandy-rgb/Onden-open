// The site, drawn by its own components, and the slots on it that answer to a click. The click
// opens 「換成…」 for that slot (a popover on a desktop, a sheet on a phone); the option the
// pointer rests on is drawn into the slot at once, and only 「套用」 saves it.
import { Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { BOX_SPECS, type BoxId, type SiteBoxes, type SiteDesign, type WidgetFacts } from "@onden/site";
import { Popover, Sheet, usePopover } from "../../../components/ui";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { lazyWithReload } from "../../../lib/lazyWithReload";
import { useT } from "../../../lib/i18n";
import type { SiteData } from "../../../components/siteFrame";
import SiteRender, { type SitePage } from "../SiteRender";
import { putInSlot, type BoxTarget, type Candidate } from "./boxEdit";
import { withDesign } from "./previewSite";
import { siteWord } from "./siteWords";

const ReplacePicker = lazyWithReload(() => import("./ReplacePicker"));

/** The slot under a click: the widget or empty box carrying `data-box` / `data-index`, or a list box's 「＋加一格」. */
export function boxSlotAt(element: Element | null): { target: BoxTarget; element: HTMLElement } | null {
  const hit = element?.closest<HTMLElement>("[data-box][data-index]");
  const box = hit?.dataset.box as BoxId | undefined;
  if (!hit || !box || !(box in BOX_SPECS)) return null;
  return { target: { box, index: Number(hit.dataset.index) || 0 }, element: hit };
}

type Props = {
  data: SiteData;
  design: SiteDesign;
  page: SitePage;
  width: number | null;
  facts: WidgetFacts;
  /** Draw only what readers see: no markers, no clicks. */
  readerOnly: boolean;
  onBoxes: (boxes: SiteBoxes) => void;
};

export default function SetupCanvas({ data, design, page, width, facts, readerOnly, onBoxes }: Props) {
  const t = useT();
  const mobile = useIsMobile();
  const [slot, setSlot] = useState<BoxTarget | null>(null);
  const [candidate, setCandidate] = useState<Candidate | undefined>(undefined);
  const close = useCallback(() => { setSlot(null); setCandidate(undefined); }, []);
  // The picker sits beside the page, at its right edge, so the slot being tried stays in view.
  const [at, setAt] = useState<{ x: number; y: number } | undefined>(undefined);
  const pop = usePopover<HTMLElement>({ open: slot !== null && !mobile, onClose: close, placement: "bottom-start", at });

  // Leaving the editable view (or the page) closes what was open on it.
  useEffect(() => { if (readerOnly) close(); }, [readerOnly, close]);
  useEffect(() => { close(); }, [page.kind, close]);

  const shown = useMemo(() => {
    const boxes = slot && candidate !== undefined ? putInSlot(design.boxes, slot, candidate) : design.boxes;
    return withDesign(data, boxes === design.boxes ? design : { ...design, boxes });
  }, [data, design, slot, candidate]);

  const open = (event: MouseEvent<HTMLElement>) => {
    // A link inside the page must not leave the screen, drawn for readers or not; the fixed parts (title, text) are not slots.
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    if (readerOnly) return;
    const found = boxSlotAt(event.target instanceof Element ? event.target : null);
    if (!found) return;
    event.preventDefault();
    pop.anchor.current = found.element;
    const area = found.element.closest(".ss-scroll")?.getBoundingClientRect();
    setAt(area ? { x: Math.max(area.left + 8, area.right - 400), y: area.top + 8 } : undefined);
    setCandidate(undefined);
    setSlot(found.target);
  };

  const picker = slot && (
    <Suspense fallback={null}>
      <ReplacePicker
        key={`${slot.box}:${slot.index}`} target={slot} boxes={design.boxes} facts={facts}
        onPreview={setCandidate}
        onApply={(next) => { onBoxes(putInSlot(design.boxes, slot, next)); close(); }}
        onBoxes={onBoxes} onClose={close}
      />
    </Suspense>
  );
  const mark = slot ? `.ss-frame [data-box="${slot.box}"][data-index="${slot.index}"] { outline: var(--ac-focus-outline); outline-offset: var(--ac-focus-offset); }` : "";

  return (
    <div className="ss-scroll">
      <div
        className="ss-frame" data-edit={readerOnly ? undefined : ""} data-testid="site-frame"
        style={{ "--ss-width": width === null ? "100%" : `${width}px` } as React.CSSProperties}
        onClickCapture={open}
      >
        {mark && <style>{mark}</style>}
        <SiteRender
          data={shown} page={page} viewport={width ?? undefined}
          {...(readerOnly ? {} : { emptyLabel: t("Empty — click to choose"), addLabel: t("＋ Add a slot"), word: siteWord })}
        />
      </div>
      {slot && !mobile && <Popover popover={pop} label={t("Replace with…")} className="ss-popover">{picker}</Popover>}
      {slot && mobile && <Sheet label={t("Replace with…")} onClose={close}>{picker}</Sheet>}
    </div>
  );
}
