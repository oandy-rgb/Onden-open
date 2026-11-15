// 「匯出 PPTX」: the small panel that opens from the 簡報 tab's button (and the
// note's command): pick the fonts, see what will change, export. A phone gets
// a bottom sheet and a desktop a card (ui/Sheet). It does the work in the
// browser; the slide is drawn once per page on a hidden stage (the same
// SlideView the tab shows) and read from there (exportDeck.ts). A cancel or a
// close stops it between pages.

import { anchorSpansOf } from "../../../lib/blockAnchorStore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Sheet, SheetHeader } from "../../../components/ui";
import { useAllNodes } from "../../../lib/appStore";
import type { ContentNode } from "../../../lib/api";
import { drafts } from "../../../lib/data";
import { downloadBlob } from "../../../lib/download";
import { useT } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";
import { noteExportFilename } from "../../../lib/noteExport";
import { layoutOfPage, pagesOf } from "../pages";
import SlideView from "../SlideView";
import { slideRenderer } from "../slideRender";
import { slidesDataOf } from "../slidesDataOf";
import { useDeckLook } from "../theme";
import "../i18n";
import { exportDeck, type Stage } from "./exportDeck";
import { substitutions, type FontChoice } from "./fonts";
import { fontKindsOf, masterLookOf, pictureLosses } from "./look";
import { settleStage } from "./settleStage";
import { ExportCancelled } from "./writePptx";
import "./exportPptx.css";

type Phase =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; missing: { slide: number; count: number }[]; inlineFormulas: number[]; texFormulas: number[] }
  | { kind: "failed" };

export default function ExportPptxDialog({ node, onOpenNode, onClose }: { node: ContentNode; onOpenNode?: (id: string) => void; onClose: () => void }) {
  const t = useT();
  const data = useMemo(() => slidesDataOf(node), [node]);
  const [markdown] = useState(() => drafts.read(node.id)?.markdown ?? node.markdown ?? "");
  const pages = useMemo(() => pagesOf(markdown, anchorSpansOf(node.id, markdown)), [markdown, node.id]);
  const { style, vars } = useDeckLook(data.theme);
  const look = useMemo(() => masterLookOf(style, vars), [style, vars]);
  const nodes = useAllNodes();
  const render = useMemo(() => slideRenderer(nodes, node, onOpenNode), [nodes, node, onOpenNode]);
  const [font, setFont] = useState<FontChoice>("common");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const running = phase.kind === "running";

  const [shown, setShown] = useState<number | null>(null);
  const stageEl = useRef<HTMLDivElement>(null);
  const waiting = useRef<{ index: number; resolve: (canvas: HTMLElement) => void } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const stage: Stage = {
    show: (index) => new Promise((resolve) => { waiting.current = { index, resolve }; setShown(index); }),
  };
  // SlideView says so once the page is laid out and fitted (from its layout effect, before this stage's ref is set:
  // hence the turn); then the stage waits for fonts and pictures.
  function fitted(index: number) {
    const ask = waiting.current;
    if (!ask || ask.index !== index) return;
    waiting.current = null;
    void Promise.resolve().then(() => {
      const host = stageEl.current!;
      return settleStage(host, abort.current?.signal ?? new AbortController().signal).then(() => ask.resolve(host.querySelector<HTMLElement>(".sv-canvas")!));
    });
  }

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "running", done: 0, total: pages.length });
    try {
      const result = await exportDeck({
        pages, stage, look, font, title: displayTitle(node.title), signal: controller.signal,
        onProgress: (done, total) => { if (!controller.signal.aborted) setPhase({ kind: "running", done, total }); },
      });
      if (controller.signal.aborted) { setPhase({ kind: "idle" }); return; }
      downloadBlob(result.blob, noteExportFilename(displayTitle(node.title), "pptx"));
      if (result.missingPictures.length === 0 && result.inlineFormulaSlides.length === 0 && result.texFormulaSlides.length === 0) onClose();
      else setPhase({ kind: "done", missing: result.missingPictures, inlineFormulas: result.inlineFormulaSlides, texFormulas: result.texFormulaSlides });
    } catch (error) {
      setPhase(error instanceof ExportCancelled || controller.signal.aborted ? { kind: "idle" } : { kind: "failed" });
    } finally {
      setShown(null);
      waiting.current = null;
    }
  }
  const cancel = () => abort.current?.abort();
  const close = () => { cancel(); onClose(); };

  const replaced = substitutions(fontKindsOf(look), font);
  const losses = pictureLosses(pages);
  const pageList = (slides: number[]) => slides.join(t(", "));

  return (
    <>
    <Sheet label={t("Export as slides (PPTX)")} cardClassName="pe-card" onClose={close}>
      <SheetHeader title={t("Export as slides (PPTX)")} onClose={close} />
      <div className="pe-body">
        {phase.kind !== "done" && (
          <>
            <span className="pe-label">{t("Fonts")}</span>
            <Segmented<FontChoice> label={t("Fonts")} value={font} onChange={setFont}
              options={[{ value: "common", label: t("Common") }, { value: "noto", label: "Noto" }, { value: "keep", label: t("Keep Onden fonts") }]} />
            <p className="pe-note">
              {replaced.length > 0
                ? t("Fonts replaced: {list}", { list: replaced.map(({ from, to }) => `${t(from)} → ${t(to)}`).join(t(", ")) })
                : t("Fonts stay as they are. A computer without them will use its own.")}
            </p>
            {losses.map(({ kind, slides }) => (
              <p className="pe-warn" key={kind}>
                {kind === "math"
                  ? t("Formulas on slide {pages} become pictures (plain TeX if this browser cannot draw them) and can't be edited in PowerPoint.", { pages: pageList(slides) })
                  : t("Diagrams on slide {pages} become pictures and can't be edited in PowerPoint.", { pages: pageList(slides) })}
              </p>
            ))}
            <p className="pe-note">{t("Handwriting is not exported.")}</p>
          </>
        )}
        {running && <p className="pe-note pe-progress" role="status">{t("Slide {n} of {total}", { n: Math.max(1, phase.done), total: phase.total })}</p>}
        {phase.kind === "failed" && <p className="pe-warn" role="alert">{t("The file could not be made. You can try again.")}</p>}
        {phase.kind === "done" && (
          <>
            <p className="pe-note" role="status">{t("Exported.")}</p>
            {phase.missing.length > 0 && (
              <p className="pe-warn">{t("Some pictures could not be read and are grey boxes: slide {pages}.", { pages: pageList(phase.missing.map((m) => m.slide)) })}</p>
            )}
            {phase.texFormulas.length > 0 && (
              <p className="pe-warn">{t("This browser could not draw the formulas on slide {pages} as pictures; they are written as plain TeX.", { pages: pageList(phase.texFormulas) })}</p>
            )}
            {phase.inlineFormulas.length > 0 && (
              <p className="pe-warn">{t("Formulas inside the text on slide {pages} are written as plain TeX, not as a formula.", { pages: pageList(phase.inlineFormulas) })}</p>
            )}
          </>
        )}
        <div className="pe-actions">
          {phase.kind === "done"
            ? <Button variant="primary" onClick={onClose}>{t("Close")}</Button>
            : running
              ? <Button onClick={cancel}>{t("Cancel")}</Button>
              : <Button variant="primary" onClick={() => { void start(); }}>{t("Export")}</Button>}
        </div>
      </div>
    </Sheet>
    {/* Beside the sheet, not in it: a 1920 × 1080 stage inside would stretch the sheet's scroll area. */}
    {shown !== null && pages[shown] && (
      <div ref={stageEl} className="pe-stage" aria-hidden="true" inert>
        <SlideView key={shown} page={pages[shown]} layout={layoutOfPage(pages[shown], data.layouts)} vars={vars} render={render} onFit={() => fitted(shown)} />
      </div>
    )}
    </>
  );
}
