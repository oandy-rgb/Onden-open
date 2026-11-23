// The note's 「簡報」 tab (docs/architecture/proposals/slides-2026-10-31.md §7.1):
// the pages cut from the note's own text, thumbnails on the left and the page
// large in the middle. Nothing is stored for a deck nobody has touched; a chosen
// layout or theme is the note's `slides_data` attribute. 「播放」 plays the same
// slides full screen (PresentationPlayer draws this view's SlideView).
import { anchorSpansOf, anchorsVersion, watchAnchors } from "../../lib/blockAnchorStore";
import { Fragment, memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Download, GripVertical, Palette, Play, Plus, Trash2 } from "lucide-react";
import { withPageLayout, withSlidesTheme, SLIDES_THEMES } from "@onden/markdown";
import { Button, Menu, MenuItem, Switch, usePopover } from "../../components/ui";
import { ReplaceWith } from "../../components/ReplaceWith";
import { isImeComposing } from "../../lib/keys";
import { stepActive } from "../../lib/listNav";
import { addToast, useAllNodes, useOverviewDraftOf } from "../../lib/appStore";
import { caretOf, focusEditorAt, placeEditorCaret, replaceEditorText, scrollEditorTo, useEditorCaret } from "../../lib/editorCaretStore";
import { useDragReorder } from "../../components/NavLayoutEditor";
import { useFollowCaret, useSplit } from "../../lib/splitViewStore";
import { drafts } from "../../lib/data";
import { useIsMobile } from "../../hooks/useIsMobile";
import { observeSize } from "../../lib/observeSize";
import { displayTitle, untitledTitle } from "../../lib/noteLabel";
import { useT } from "../../lib/i18n";
import type { NoteViewPaneProps } from "../types";
import { LAYOUTS, TABLE_TOO_MUCH_HINT, TOO_MUCH_HINT, alternativeLayout, hasTable, layoutSpec } from "./layouts";
import { chosenLayout, isLayoutId, layoutOfPage, layoutsByPageKey, pagesOf, type LayoutId, type Page } from "./pages";
import { carryLayouts, deletePage, duplicatePage, insertPage, movePage, pageIndexAt, pageTextAt, undoLayouts, type DeckEdit } from "./deckEdit";
import SlideView, { type SlideFit } from "./SlideView";
import { openPptxExport } from "./exportPptx/open";
import { presentNote } from "./present";
import { rememberSlide, slideIndexFor } from "./slideSelection";
import { slideRenderer } from "./slideRender";
import { THEME_LABELS, useDeckLook } from "./theme";
import { useSlidesData } from "./useSlidesData";
import "./i18n";
import "./slidesPane.css";

/** The 「自動」 choice in the 換成… list (no layout stored for the page). */
const AUTO = "auto";

const lf = (text: string) => text.replace(/\r\n/g, "\n");

/** A thumbnail's picture: drawn again only when its page, layout or look changes, not at every caret move of the pane. */
const ThumbPic = memo(function ThumbPic({ page, layout, vars, render }: { page: Page; layout: LayoutId; vars: React.ComponentProps<typeof SlideView>["vars"]; render: React.ComponentProps<typeof SlideView>["render"] }) {
  return <SlideView page={page} layout={layout} vars={vars} render={render} />;
});

/** slidesPane.css `@container sp (max-width: 719px)`: below this pane width the thumbnails are a row. */
const SP_ROW_BELOW_PX = 720;

export default function SlidesPane({ node, canEdit, onOpenNode }: NoteViewPaneProps) {
  const t = useT();
  const mobile = useIsMobile();
  // The pane's own width, not the window's: slidesPane.css lays the thumbnails out as a row under 720px of pane (a
  // phone, or a narrow side-by-side pane), and then the selected slide's tools go above the list, as on a phone; left in
  // the 112px thumbnail they covered it (e2e slidesEdit, 2026-11-24). Unmeasured (0) keeps the column.
  const paneRef = useRef<HTMLDivElement>(null);
  const [narrowPane, setNarrowPane] = useState(false);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => { const width = pane.getBoundingClientRect().width; setNarrowPane(width > 0 && width < SP_ROW_BELOW_PX); };
    measure();
    return observeSize(pane, measure);
  }, []);
  const toolsAbove = mobile || narrowPane;
  const nodes = useAllNodes();
  const { data, change } = useSlidesData(node);
  const { vars } = useDeckLook(data.theme);
  // What the editor shows, saved or not (the same text the player reads). Typing beside it changes the draft, and this
  // pane reads it again as it changes; the slides catch up after a keystroke rather than during it (a long deck is cut
  // again at every one). An operation therefore checks that the page it was given is still that page (`shown`).
  useOverviewDraftOf(node.id);
  const markdown = useDeferredValue(drafts.read(node.id)?.markdown ?? node.markdown ?? "");
  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the held anchors change with `anchorsSeen`
  const pages = useMemo(() => pagesOf(markdown, anchorSpansOf(node.id, markdown)), [markdown, node.id, anchorsSeen]);
  // Chosen by the page's key (see slideSelection.ts); the state only re-renders, the memory is the module's.
  const [, setChosenAt] = useState(0);
  const index = slideIndexFor(node.id, pages);
  const page = pages[index];
  // `among`: the pages the index is of (after an operation, the pages it made, which are not drawn yet).
  const setSelected = (i: number, among: readonly { key: string }[] = pages) => { if (among[i]) rememberSlide(node.id, among[i].key, i); setChosenAt((n) => n + 1); };
  // Keep the memory on the page actually shown (a deleted page's neighbour becomes the one to follow).
  useEffect(() => { rememberSlide(node.id, page.key, index); }, [node.id, page.key, index]);
  // 並排: this note's own text is open in an editor on the other side. The slides follow its caret, and a thumbnail
  // pressed here scrolls that text to the page. Without one, this pane is what it always was.
  const split = useSplit();
  const editorOpen = useEditorCaret(node.id, (c) => c !== null);
  const beside = editorOpen && split.right !== null;
  const [follow, setFollow] = useFollowCaret();
  // The page of the caret: a number, so the pane is drawn again when the caret goes to another page, not at every move.
  const caretPage = useEditorCaret(node.id, (c) => (beside && c ? pageIndexAt(pages, c.from) : null));
  const followed = useRef<number | null>(null);
  // Held while an operation of this pane moves the text under the caret: the caret then passes by pages it is not in.
  const holdFollow = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  // Follow when the caret moves to another page. A page chosen here by hand stays until the caret goes to another one.
  useEffect(() => {
    if (!follow || caretPage === null) { followed.current = null; return; }
    if (holdFollow.current || followed.current === caretPage) return;
    followed.current = caretPage;
    setSelected(caretPage);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setSelected reads the pages of this render
  }, [follow, caretPage]);
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
  // Closing the player leaves the view on the page last seen there.
  const play = () => presentNote(node, onOpenNode, index, (key, i) => { rememberSlide(node.id, key, i); setChosenAt((n) => n + 1); });
  const pick = (next: LayoutId | null) => { closeLayouts(); change(withPageLayout({ ...data, layouts: layoutsByPageKey(pages, data.layouts) }, page.key, next)); };
  // Another page, another preview: a half-chosen layout belongs to the page it was shown on.
  const select = (i: number) => {
    if (i !== index) closeLayouts();
    setSelected(i);
    if (beside && pages[i]) scrollEditorTo(node.id, pages[i].range?.from ?? 0);
  };

  // ── Page operations: each is one change of the note's text, and one step back ─────────────────────────────
  const titleOf = (p: Page | undefined) => p?.parts.heading || untitledTitle();
  type Made = { edit: DeckEdit; before: Page[]; after: Page[]; body: string };
  /** Page `i` as this pane shows it: the operation is not done on a page that has been typed over since. */
  // Ranges count a text whose line ends are `\n` (the cut reads `\r\n` as one), so it is that text they cut.
  const shown = (i: number) => (pages[i]?.range ? lf(markdown).slice(pages[i].range!.from, pages[i].range!.to) : null);
  async function editPages(check: readonly number[], make: (body: string) => DeckEdit | null, say: (before: Page[], after: Page[], at: number) => string) {
    if (!canEdit) return;
    // The operation runs on the text as it is when it is applied, whatever was typed a moment ago.
    let made = null as Made | null;
    let stale = false;
    const run = (body: string) => {
      const spans = anchorSpansOf(node.id, body);
      made = null;
      stale = !check.every((i) => pageTextAt(body, i) === shown(i));
      const edit = stale ? null : make(body);
      if (!edit) return body;
      const kept = spans.flatMap((a) => { const from = edit.map(a.from), to = edit.map(a.to); return from !== null && to !== null && from < to ? [{ id: a.id, from, to }] : []; });
      made = { edit, before: pagesOf(body, spans), after: pagesOf(edit.text, kept), body };
      return edit.text;
    };
    const caretBefore = caretOf(node.id);
    holdFollow.current = beside;
    // With the editor open the edit is the editor's own (one Ctrl+Z steps it back); without one it is a saved change of the note.
    const result = replaceEditorText(node.id, run) ? "applied" : await drafts.editText(node.id, run);
    const done = made as Made | null;
    if (result !== "applied" || !done) {
      holdFollow.current = false;
      if (result === "applied") addToast(t(stale ? "The slides were changing while you pressed that. Try again." : "This would change how the note is cut into slides, so it was not done."), "info");
      return;
    }
    const { edit, before, after, body } = done;
    // A layout chosen for a page goes with the page: each stored choice moves to the key of the page it was chosen for.
    const wasLayouts = dataRef.current.layouts;
    const layouts = carryLayouts(layoutsByPageKey(before, wasLayouts), before.map((p) => p.key), after.map((p) => p.key), edit.order);
    const layoutsChanged = JSON.stringify(layouts) !== JSON.stringify(wasLayouts);
    if (layoutsChanged) change({ ...dataRef.current, layouts });
    closeLayouts();
    setSelected(edit.select, after);
    if (beside) {
      // The editor took the new text in as one replacement and the caret fell to its edge: put it back where its text went.
      const mapped = caretBefore ? edit.map(caretBefore.from) : null;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (edit.caret !== undefined) focusEditorAt(node.id, edit.caret);
        else if (mapped !== null) placeEditorCaret(node.id, mapped);
        followed.current = pageIndexAt(after, edit.caret ?? mapped ?? 0);
        holdFollow.current = false;
        if (edit.caret === undefined && after[edit.select]) scrollEditorTo(node.id, after[edit.select].range?.from ?? 0);
      }));
    }
    const wasAt = index;
    addToast(say(before, after, edit.select), "success", {
      label: t("Undo"),
      onClick: () => void (async () => {
        // Only the text this operation made is put back: anything written since is never overwritten.
        let reverted = false;
        const revert = (current: string) => { reverted = lf(current) === lf(edit.text); return reverted ? body : current; };
        const outcome = replaceEditorText(node.id, revert) ? "applied" : await drafts.editText(node.id, revert);
        if (outcome !== "applied") return;
        if (!reverted) { addToast(t("The note was changed since, so this was not undone."), "info"); return; }
        // Only this operation's choices go back: a theme or layout chosen since stays.
        if (layoutsChanged) change({ ...dataRef.current, layouts: undoLayouts(dataRef.current.layouts, wasLayouts, layouts) });
        setSelected(wasAt, before);
      })(),
    });
  }
  const moveTo = (from: number, to: number) => void editPages([from, to], (body) => movePage(body, from, to),
    (before, _after, at) => t("Moved “{title}” to slide {n}", { title: titleOf(before[from]), n: at + 1 }));
  const copyPage = (i: number) => void editPages([i], (body) => duplicatePage(body, i), (before) => t("Copied “{title}”", { title: titleOf(before[i]) }));
  const removePage = (i: number) => void editPages([i], (body) => deletePage(body, i), (before) => t("Deleted “{title}”", { title: titleOf(before[i]) }));
  const addPage = (at: number) => void editPages([Math.max(0, at - 1)], (body) => insertPage(body, at, t("New slide")), () => t("Added a slide"));
  // Dragging a thumbnail by its grip (the app's one pointer drag-to-reorder, which touch and pen drive too): dropped before
  // the thumbnail at `over`.
  const { drag, handle } = useDragReorder((key, over) => {
    const from = pages.findIndex((p) => p.key === key);
    const to = over > from ? over - 1 : over;
    if (from >= 0 && to !== from) moveTo(from, to);
  }, () => {});
  const layoutOptions = useMemo(() => [
    { id: AUTO, label: t("Automatic"), hint: t("Let the slide choose by what is on it."), thumb: <SlideView page={page} layout={page.autoLayout} vars={vars} render={render} /> },
    ...LAYOUTS.map((spec) => ({ id: spec.id as string, label: t(spec.label), hint: t(spec.blurb), thumb: <SlideView page={page} layout={spec.id} vars={vars} render={render} /> })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [page, vars, render]);

  // ← and → change the page from anywhere in the pane; ↑ and ↓ walk the thumbnails, whichever way the strip runs
  // (a column on a desktop, a row on a phone), so the thumbnails also take ← and →. Keys that belong to a field,
  // a menu or the 「換成…」 list stay theirs.
  function onKey(e: React.KeyboardEvent) {
    // Alt+↑ / Alt+↓ on a thumbnail moves its page up or down (the 上移／下移 buttons are the other way to do it).
    if (canEdit && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.defaultPrevented && listRef.current?.contains(e.target as Node)) {
      const to = e.key.startsWith("ArrowU") || e.key.startsWith("ArrowD") ? stepActive(e.key, index, pages.length) : null;
      if (to === null) return;
      e.preventDefault();
      moveTo(index, to);
      // The moved page's thumbnail keeps the focus once the list has been drawn again.
      requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>(".sp-hit")[to]?.focus());
      return;
    }
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

  const last = pages.length - 1;
  const tools = canEdit ? (
    <div className="sp-tools" role="group" aria-label={t("This slide")}>
      <Button variant="icon" size="sm" title={t("Move up")} aria-label={t("Move up")} disabled={index === 0} onClick={() => moveTo(index, index - 1)}><ArrowUp size={16} aria-hidden="true" /></Button>
      <Button variant="icon" size="sm" title={t("Move down")} aria-label={t("Move down")} disabled={index === last} onClick={() => moveTo(index, index + 1)}><ArrowDown size={16} aria-hidden="true" /></Button>
      <Button variant="icon" size="sm" title={t("Copy this slide")} aria-label={t("Copy this slide")} onClick={() => copyPage(index)}><Copy size={16} aria-hidden="true" /></Button>
      <Button variant="icon" size="sm" title={t("Delete this slide")} aria-label={t("Delete this slide")} disabled={pages.length < 2} onClick={() => removePage(index)}><Trash2 size={16} aria-hidden="true" /></Button>
      <Button variant="icon" size="sm" title={t("Add a slide after this one")} aria-label={t("Add a slide after this one")} onClick={() => addPage(index + 1)}><Plus size={16} aria-hidden="true" /></Button>
    </div>
  ) : null;

  return (
    <div ref={paneRef} className="sp" onKeyDown={onKey}>
      <h1 className="sp-title">{displayTitle(node.title)}</h1>
      <div className={`sp-main${layoutOpen && !mobile ? " has-replace" : ""}`}>
        <div className="sp-side">
          {toolsAbove && tools}
          <ol ref={listRef} className="sp-thumbs" aria-label={t("Slides")}>
            {pages.map((p, i) => {
              const own = chosenLayout(p, data.layouts);
              const thumbLayout: LayoutId = layoutOfPage(p, data.layouts);
              return (
                <Fragment key={p.key}>
                  {/* Between two thumbnails: add a slide here (the mouse's way; the keyboard has the button in the tools). */}
                  {canEdit && i > 0 && !mobile && (
                    <li className="sp-gap"><Button variant="icon" size="sm" className="sp-add" tabIndex={-1} title={t("Add a slide here")} aria-label={t("Add a slide here")} onClick={() => addPage(i)}><Plus size={16} aria-hidden="true" /></Button></li>
                  )}
                  <li data-reorder-index={i} className={`sp-thumb${i === index ? " is-on" : ""}${drag?.id === p.key ? " is-dragging" : ""}${drag && drag.over === i && drag.id !== p.key ? " is-over" : ""}`}>
                    <span className="sp-thumb-n">{i + 1}{own ? <i className="sp-thumb-dot" aria-hidden="true" /> : null}</span>
                    <span className="sp-thumb-pic" aria-hidden="true" inert><ThumbPic page={p} layout={thumbLayout} vars={vars} render={render} /></span>
                    {/* The button sits over the picture, not around it: a slide can hold links and buttons of its own. */}
                    <Button variant="ghost" className="sp-hit" aria-current={i === index ? "true" : undefined} aria-label={t("Slide {n}", { n: i + 1 })} onClick={() => select(i)} />
                    {canEdit && !mobile && (
                      <Button variant="icon" size="sm" className="sp-grip" title={t("Drag to move")} aria-label={t("Drag to move")} {...handle(p.key, i)}><GripVertical size={16} aria-hidden="true" /></Button>
                    )}
                    {i === index && !toolsAbove && tools}
                  </li>
                </Fragment>
              );
            })}
            {canEdit && (
              <li className={`sp-end${drag && drag.over === pages.length ? " is-over" : ""}`}><Button size="sm" onClick={() => addPage(pages.length)}><Plus size={16} aria-hidden="true" /> {t("Add a slide")}</Button></li>
            )}
          </ol>
        </div>
        <div className="sp-stage">
          <div className="sp-big">
            <SlideView page={page} layout={layout} vars={vars} render={render} onFit={setFit} />
            {/* A press on the slide opens 「換成…」 like the button does; the button is the way in for the keyboard. */}
            {canEdit && <Button variant="ghost" className="sp-hit" tabIndex={-1} aria-hidden="true" onClick={() => (layoutOpen ? closeLayouts() : setLayoutOpen(true))} />}
          </div>
          {beside && (
            <div className="sp-follow">
              <span aria-live="polite">{t("Slide {n} of {total}", { n: index + 1, total: pages.length })}</span>
              <label className="sp-follow-switch"><Switch on={follow} label={t("Follow the caret")} onChange={setFollow} /> {t("Follow the caret")}</label>
            </div>
          )}
          <div className="sp-bar">
            <Button size="sm" title={t("Layout")} aria-expanded={layoutOpen} disabled={!canEdit} onClick={() => (layoutOpen ? closeLayouts() : setLayoutOpen(true))}>
              {t("Layout: {name}", { name: chosen && isLayoutId(chosen) ? t(layoutSpec(chosen).label) : t("Automatic") })}
            </Button>
            <Button size="sm" ref={themeMenu.anchor} aria-haspopup="menu" aria-expanded={themeOpen} disabled={!canEdit} onClick={() => setThemeOpen((v) => !v)}>
              <Palette size={16} aria-hidden="true" /> {t(THEME_LABELS[data.theme])}
            </Button>
            {/* Reading only: a note you can't edit can still be exported. */}
            <Button size="sm" onClick={() => openPptxExport(node, onOpenNode)}><Download size={16} aria-hidden="true" /> {t("Export PPTX")}</Button>
            <Button size="sm" variant="primary" onClick={play}><Play size={16} aria-hidden="true" /> {t("Play")}</Button>
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
              {data.theme === theme ? <Check size={16} aria-hidden="true" /> : <span className="sp-check-gap" />} {t(THEME_LABELS[theme])}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
