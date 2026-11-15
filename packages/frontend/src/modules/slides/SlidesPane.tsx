// The note's 「簡報」 tab (docs/architecture/proposals/slides-2026-10-31.md §7.1):
// the pages cut from the note's own text, thumbnails on the left and the page
// large in the middle. Nothing is stored for a deck nobody has touched; a chosen
// layout or theme is the note's `slides_data` attribute. 「播放」 plays the same
// slides full screen (PresentationPlayer draws this view's SlideView).
import { anchorSpansOf, anchorsVersion, watchAnchors } from "../../lib/blockAnchorStore";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Download, Palette, Play } from "lucide-react";
import { withPageLayout, withSlidesTheme, SLIDES_THEMES } from "@onden/markdown";
import { Button, Menu, MenuItem, usePopover } from "../../components/ui";
import { ReplaceWith } from "../../components/ReplaceWith";
import { isImeComposing } from "../../lib/keys";
import { stepActive } from "../../lib/listNav";
import { useAllNodes } from "../../lib/appStore";
import { drafts } from "../../lib/data";
import { useIsMobile } from "../../hooks/useIsMobile";
import { displayTitle } from "../../lib/noteLabel";
import { useT } from "../../lib/i18n";
import type { NoteViewPaneProps } from "../types";
import { LAYOUTS, TABLE_TOO_MUCH_HINT, TOO_MUCH_HINT, alternativeLayout, hasTable, layoutSpec } from "./layouts";
import { chosenLayout, isLayoutId, layoutOfPage, layoutsByPageKey, pagesOf, type LayoutId } from "./pages";
import SlideView, { type SlideFit } from "./SlideView";
import { openPptxExport } from "./exportPptx/open";
import { presentNote } from "./present";
import { slideRenderer } from "./slideRender";
import { THEME_LABELS, useDeckLook } from "./theme";
import { useSlidesData } from "./useSlidesData";
import "./i18n";
import "./slidesPane.css";

/** The 「自動」 choice in the 換成… list (no layout stored for the page). */
const AUTO = "auto";

export default function SlidesPane({ node, canEdit, onOpenNode }: NoteViewPaneProps) {
  const t = useT();
  const mobile = useIsMobile();
  const nodes = useAllNodes();
  const { data, change } = useSlidesData(node);
  const { vars } = useDeckLook(data.theme);
  // What the editor shows, saved or not (the same text the player reads).
  const markdown = drafts.read(node.id)?.markdown ?? node.markdown ?? "";
  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the held anchors change with `anchorsSeen`
  const pages = useMemo(() => pagesOf(markdown, anchorSpansOf(node.id, markdown)), [markdown, node.id, anchorsSeen]);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, pages.length - 1);
  const page = pages[index];
  const chosen = chosenLayout(page, data.layouts);
  const savedLayout: LayoutId = layoutOfPage(page, data.layouts);
  const render = useMemo(() => slideRenderer(nodes, node, onOpenNode), [nodes, node, onOpenNode]);
  // 「換成…」: the layout being previewed on this page's own words (null: none), drawn in place of the saved one.
  const [preview, setPreview] = useState<string | null>(null);
  const layout: LayoutId = preview !== null ? (preview === AUTO ? page.autoLayout : (preview as LayoutId)) : savedLayout;
  const [fit, setFit] = useState<SlideFit>({ shrunk: false, overflow: false });
  const listRef = useRef<HTMLOListElement>(null);

  const [layoutOpen, setLayoutOpen] = useState(false);
  const closeLayouts = () => { setLayoutOpen(false); setPreview(null); };
  const [themeOpen, setThemeOpen] = useState(false);
  const themeMenu = usePopover<HTMLButtonElement>({ open: themeOpen, onClose: () => setThemeOpen(false), placement: "top-start" });

  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [index]);

  const alternative = fit.overflow ? alternativeLayout(layout, page.parts) : null;
  const play = () => presentNote(node, onOpenNode, index);
  const pick = (next: LayoutId | null) => { closeLayouts(); change(withPageLayout({ ...data, layouts: layoutsByPageKey(pages, data.layouts) }, page.key, next)); };
  // Another page, another preview: a half-chosen layout belongs to the page it was shown on.
  const select = (i: number) => { if (i !== index) closeLayouts(); setSelected(i); };
  const layoutOptions = useMemo(() => [
    { id: AUTO, label: t("Automatic"), hint: t("Let the slide choose by what is on it."), thumb: <SlideView page={page} layout={page.autoLayout} vars={vars} render={render} /> },
    ...LAYOUTS.map((spec) => ({ id: spec.id as string, label: t(spec.label), hint: t(spec.blurb), thumb: <SlideView page={page} layout={spec.id} vars={vars} render={render} /> })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [page, vars, render]);

  // ← and → change the page from anywhere in the pane; ↑ and ↓ walk the thumbnails, whichever way the strip runs
  // (a column on a desktop, a row on a phone), so the thumbnails also take ← and →. Keys that belong to a field,
  // a menu or the 「換成…」 list stay theirs.
  function onKey(e: React.KeyboardEvent) {
    if (e.defaultPrevented || isImeComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true'], [role='menu'], .ui-replace")) return;
    const inThumbs = listRef.current?.contains(e.target as Node) ?? false;
    const key = e.key === "ArrowLeft" ? "ArrowUp" : e.key === "ArrowRight" ? "ArrowDown" : inThumbs ? e.key : "";
    const next = stepActive(key, index, pages.length);
    if (next === null) return;
    e.preventDefault();
    select(next);
    if (inThumbs) listRef.current?.querySelectorAll<HTMLElement>(".sp-hit")[next]?.focus();
  }

  return (
    <div className="sp" onKeyDown={onKey}>
      <h1 className="sp-title">{displayTitle(node.title)}</h1>
      <div className={`sp-main${layoutOpen && !mobile ? " has-replace" : ""}`}>
        <ol ref={listRef} className="sp-thumbs" aria-label={t("Slides")}>
          {pages.map((p, i) => {
            const own = chosenLayout(p, data.layouts);
            const thumbLayout: LayoutId = layoutOfPage(p, data.layouts);
            return (
              <li key={p.key} className={`sp-thumb${i === index ? " is-on" : ""}`}>
                <span className="sp-thumb-n">{i + 1}{own ? <i className="sp-thumb-dot" aria-hidden="true" /> : null}</span>
                <span className="sp-thumb-pic" aria-hidden="true" inert><SlideView page={p} layout={thumbLayout} vars={vars} render={render} /></span>
                {/* The button sits over the picture, not around it: a slide can hold links and buttons of its own. */}
                <Button variant="ghost" className="sp-hit" aria-current={i === index ? "true" : undefined} aria-label={t("Slide {n}", { n: i + 1 })} onClick={() => select(i)} />
              </li>
            );
          })}
        </ol>
        <div className="sp-stage">
          <div className="sp-big">
            <SlideView page={page} layout={layout} vars={vars} render={render} onFit={setFit} />
            {/* A press on the slide opens 「換成…」 like the button does; the button is the way in for the keyboard. */}
            {canEdit && <Button variant="ghost" className="sp-hit" tabIndex={-1} aria-hidden="true" onClick={() => (layoutOpen ? closeLayouts() : setLayoutOpen(true))} />}
          </div>
          <div className="sp-bar">
            <Button size="sm" title={t("Layout")} aria-expanded={layoutOpen} disabled={!canEdit} onClick={() => (layoutOpen ? closeLayouts() : setLayoutOpen(true))}>
              {t("Layout: {name}", { name: chosen && isLayoutId(chosen) ? t(layoutSpec(chosen).label) : t("Automatic") })}
            </Button>
            <Button size="sm" ref={themeMenu.anchor} aria-haspopup="menu" aria-expanded={themeOpen} disabled={!canEdit} onClick={() => setThemeOpen((v) => !v)}>
              <Palette size={14} aria-hidden="true" /> {t(THEME_LABELS[data.theme])}
            </Button>
            {/* Reading only: a note you can't edit can still be exported. */}
            <Button size="sm" onClick={() => openPptxExport(node, onOpenNode)}><Download size={14} aria-hidden="true" /> {t("Export PPTX")}</Button>
            <Button size="sm" variant="primary" onClick={play}><Play size={14} aria-hidden="true" /> {t("Play")}</Button>
          </div>
          {fit.overflow && (
            <p className="sp-hint" role="status">
              {alternative
                ? <>{t("This slide has a lot on it.")} <Button variant="ghost" size="sm" onClick={() => pick(alternative)}>{t("Use “{name}” instead", { name: t(layoutSpec(alternative).label) })}</Button></>
                : t(hasTable(page.parts) ? TABLE_TOO_MUCH_HINT : TOO_MUCH_HINT)}
            </p>
          )}
          <p className="sp-rule">{t("Paragraphs stay as speaker notes. To put words on the slide, write them as a list or a quotation.")}</p>
          {page.notes && (
            <details className="sp-notes">
              <summary>{t("Speaker notes")}</summary>
              <div>{render(page.notes)}</div>
            </details>
          )}
        </div>
        {layoutOpen && (
          <ReplaceWith title={t("Change to…")} applyLabel={t("Apply")} mobile={mobile} className="sp-replace" options={layoutOptions}
            current={chosen && isLayoutId(chosen) ? chosen : AUTO} onPreview={setPreview}
            onApply={(id) => pick(id === AUTO ? null : (id as LayoutId))} onClose={closeLayouts} />
        )}
      </div>

      {themeOpen && (
        <Menu popover={themeMenu} label={t("Theme")} sheet={mobile}>
          {SLIDES_THEMES.map((theme) => (
            <MenuItem key={theme} onSelect={() => change(withSlidesTheme(data, theme))}>
              {data.theme === theme ? <Check size={14} aria-hidden="true" /> : <span className="sp-check-gap" />} {t(THEME_LABELS[theme])}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
