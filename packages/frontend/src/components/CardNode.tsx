import { toEmbedUrl, EMBED_IFRAME_SANDBOX, isHttpUrl, splitParagraphs } from "@onden/markdown";
import { Fragment, useCallback, useRef, useState, useEffect, useContext } from "react";
import "./CardNode.css";
import "./MarkdownRenderer.css";
import { MediaPlayer } from "./MediaPlayer";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { clusterKeymap } from "../lib/editorCharKeys";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import MarkdownRenderer from "./MarkdownRenderer";
import { Handle, NodeResizer, Position, useStore, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Bold, Italic, Strikethrough, Code, LayoutDashboard, Plus, Globe, ExternalLink, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { t as tr } from "../lib/i18n";
import { mediaOnlyCard } from "../lib/cardBody";
import { toggleTaskLine } from "../lib/taskCheckbox";
import { GraphCallbacksContext } from "./graphCallbacks";
import { useCardDraft } from "../hooks/useCardDraft";
import { claimCardTitleFocus, onCardTitleFocusRequest } from "../lib/cardTitleFocus";
import { isEnterKey } from "../lib/keys";
import { matchShortcut } from "../lib/shortcuts";
import { selectionBubblePosition } from "../lib/selectionBubble";
import { Popover, keepFocus, useInlinePopover, type PopoverPoint, Pressable, Link, Img, TextField } from "./ui";
import { formatKeyBindings, toggleWrap } from "../lib/editorFormat";
import { cjkEmphasis } from "../lib/editorCjkEmphasis";
import { activeElement } from "../lib/documentAccess";
import { bodyOverflows, sectionHidesCards, showsTitleOnly, titleCanvasPx } from "../lib/cardDisplay";
import { observeSize } from "../lib/observeSize";
import { isCoarsePointer } from "../lib/mediaQuery";


// ── CodeMirror card theme ─────────────────────────────────────────────────────

const cardTheme = EditorView.theme({
  "&": { fontSize: "12.5px", fontFamily: "ui-monospace, Menlo, monospace" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", maxHeight: "280px", lineHeight: "1.65", minHeight: "80px" },
  ".cm-content": { padding: "4px 6px" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ac-accent)", borderLeftWidth: "1.5px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":
    { background: "color-mix(in srgb, var(--ac-accent) 20%, transparent)" },
  ".cm-activeLine": { background: "transparent" },
  ".cm-gutters": { display: "none" },
});

const cardHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700" },
  { tag: t.heading2, fontWeight: "700" },
  { tag: t.heading3, fontWeight: "700" },
  { tag: t.strong,   fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--ac-muted)" },
  { tag: t.link,     color: "var(--ac-accent)" },
  { tag: t.monospace, fontFamily: "monospace", fontSize: "0.85em" },
  { tag: t.meta,     color: "var(--ac-muted)" },
  { tag: t.processingInstruction, color: "var(--ac-muted)" },
]);

// ── Component ─────────────────────────────────────────────────────────────────

export function CardNode({ id, data, selected }: NodeProps) {
  const {
    onNodeUpdate, onNodeEditStart, onNodeResized, onNodeTitleChange,
    onClickWikilink, onSetFolded, onFocusCard, onOpenCard, onOpenSubCanvas, onToggleBranch,
  } = useContext(GraphCallbacksContext);
  /** On the board's sub-note tree: what sits below this card and whether it shows. */
  const branch = data.branch as { expanded: boolean; below: number } | undefined;

  const draft = useCardDraft(id, (data.content as string) ?? "", onNodeUpdate);
  const { flush: flushDraft } = draft;
  // Stable for the preview's pipeline memo; reads the latest callback.
  const clickWikilinkRef = useRef(onClickWikilink);
  useEffect(() => { clickWikilinkRef.current = onClickWikilink; }, [onClickWikilink]);
  const openCardLink = useCallback((label: string) => clickWikilinkRef.current(label, id), [id]);
  // GAP-177: the preview's handlers keep ONE identity. MarkdownRenderer
  // rebuilds its element types when a handler changes, so an inline toggle
  // remounted every checkbox and link on each card render — and React Flow
  // re-renders the card between pointerdown and pointerup, so the press
  // ended on a replaced element and its click was lost (a first click on a
  // checkbox or a [[link]] did nothing).
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const toggleCardTask = useCallback((index: number) => {
    const current = draftRef.current;
    current.edit(toggleTaskLine(current.content, index));
    void current.flush();
  }, []);
  const cmContainer = useRef<HTMLDivElement>(null);
  const viewRef     = useRef<EditorView | null>(null);
  const toolbarRef  = useRef<{ from: number; to: number } | null>(null);

  const zoom       = useStore(s => s.transform[2]);
  const folded     = !!data.folded;
  // A card with no height of its own shows at most BODY_MAX_H of its note and fades out.
  const autoHeight = !!data.autoHeight;
  // Sections LOD (Heptabase-style): far enough out, cards inside a section
  // disappear and the section is a single big label. The thresholds are
  // lib/cardDisplay's, in one monotonic order: full → titles only → section only.
  const containedSectionId = data.containedSectionId as string | undefined;


  const [titleDraft, setTitleDraft] = useState(data.label as string);
  const [hovered,    setHovered]    = useState(false);
  // The untrusted URL whose page the person asked to load (a web card is a link until then).
  const [loadedUrl,  setLoadedUrl]  = useState<string | null>(null);
  const [isEditing,  setIsEditing]  = useState(false);
  // A display change must not unmount the editor holding the current input.
  const titleOnly = !isEditing && showsTitleOnly(zoom, { titleOnlyFar: data.titleOnlyFar !== false });
  const hiddenBySectionLOD = sectionHidesCards(zoom) && !!containedSectionId && !selected && !isEditing;
  const [bodyClipped, setBodyClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [toolbar,    setToolbar]    = useState<(PopoverPoint & { from: number; to: number }) | null>(null);
  const bubblePop = useInlinePopover({ open: isEditing && !!toolbar, onClose: () => setToolbar(null), at: toolbar ?? undefined });
  const titleFocused = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // On a touch screen a press on a card is a drag, selected or not: only the card being edited, or its title once
  // tapped again, holds the finger. (A mouse keeps its title field and selected body clickable as they were.)
  const touchFirst = isCoarsePointer();
  const heldWhenPressed = useRef(false);

  // A card just created by clicking the board: put the caret in its title,
  // with the default name selected so typing replaces it.
  // React Flow keeps a new node hidden until it is measured, and focus() on a
  // hidden input does nothing, so retry for a few frames until it takes.
  useEffect(() => {
    let frame = 0;
    const tryFocus = (attempt: number) => {
      const input = titleInputRef.current;
      if (!input) return;
      input.focus();
      if (activeElement() === input) { input.select(); return; }
      if (attempt < 30) frame = requestAnimationFrame(() => tryFocus(attempt + 1));
    };
    const focusTitle = () => {
      if (!titleInputRef.current || !claimCardTitleFocus(id)) return;
      tryFocus(0);
    };
    focusTitle();
    const off = onCardTitleFocusRequest((nodeId) => { if (nodeId === id) focusTitle(); });
    return () => { off(); cancelAnimationFrame(frame); };
  }, [id, titleOnly]);

  // The lines run to the title's middle in far zoom: React Flow measures handles when the node
  // is resized, and a title-only card keeps its node's size, so tell it the handles moved.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, titleOnly, folded, data.maxTitleWidth, updateNodeInternals]);

  useEffect(() => {
    if (!titleFocused.current) setTitleDraft(data.label as string);
  }, [data.label]);

  useEffect(() => {
    if (isEditing) return onNodeEditStart(id);
  }, [id, isEditing, onNodeEditStart]);

  // ── Initialize CodeMirror ──────────────────────────────────────────────────
  // LAZY: the editor is only built when the card enters edit mode. A board can
  // mount HUNDREDS of cards at once; eagerly spinning up a CodeMirror EditorView
  // per card blocked the main thread long enough that a 300-card board never
  // finished its first paint (the canvasScale e2e timed out waiting for any
  // .react-flow__node). The non-editing card already renders via MarkdownRenderer,
  // so CodeMirror is pure edit-mode machinery — defer it until needed.
  useEffect(() => {
    if (!isEditing) return;
    if (!cmContainer.current) return;
    if (viewRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: draft.content,
        extensions: [
          history(),
          markdown({ base: markdownLanguage, extensions: [cjkEmphasis] }),
          EditorView.lineWrapping,
          syntaxHighlighting(cardHighlight),
          cardTheme,
          keymap.of([
            // "Save draft" in whatever chord it has on this device; returning
            // true makes CodeMirror preventDefault, so the app's dispatcher
            // (matchShortcut) leaves this press to the card.
            { any: (_v, e) => {
              if (matchShortcut(e)?.id !== "save-draft") return false;
              void flushDraft();
              return true;
            }},
            // The main editor's formatting keys (lib/editorFormat FORMAT_KEYS).
            ...formatKeyBindings(wrapCmd),
            ...clusterKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              draft.edit(update.state.doc.toString());
              setToolbar(null);
            }
            if (update.selectionSet && !update.docChanged) {
              const { from, to } = update.state.selection.main;
              if (from !== to) {
                const at = selectionBubblePosition(update.view, from, to);
                if (at) {
                  toolbarRef.current = { from, to };
                  setToolbar({ ...at, from, to });
                }
              } else {
                setToolbar(null);
              }
            }
          }),
        ],
      }),
      parent: cmContainer.current,
    });

    viewRef.current = view;
    // Focus is handled by the "enter edit mode" effect below: it runs after this
    // one (declaration order) so viewRef is already set by the time it fires.
    return () => { void flushDraft(); view.destroy(); viewRef.current = null; };
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the note is taller than the limit (then it fades and offers 「開啟完整筆記」).
  useEffect(() => {
    const preview = previewRef.current;
    const body = bodyRef.current;
    if (!autoHeight || !preview || !body || titleOnly || folded) { setBodyClipped(false); return; }
    return observeSize(preview, () => setBodyClipped(bodyOverflows(body.scrollHeight)));
  }, [autoHeight, titleOnly, folded, draft.content, isEditing]);

  // Sync content from outside when not editing
  useEffect(() => {
    if (isEditing) return;
    const view = viewRef.current;
    if (!view) return;
    const cur  = view.state.doc.toString();
    const next = (data.content as string) ?? "";
    if (cur !== next) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
    }
  }, [data.content, isEditing]);

  // Focus editor when entering edit mode
  useEffect(() => {
    if (isEditing) {
      const view = viewRef.current;
      if (view) {
        const focus = setTimeout(() => { view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } }); }, 0);
        return () => clearTimeout(focus);
      }
    } else {
      setToolbar(null);
    }
  }, [isEditing]);

  // Exit edit mode when deselected
  useEffect(() => { if (!selected) { void flushDraft(); setIsEditing(false); } }, [selected, flushDraft]);

  // ── Formatting helpers ─────────────────────────────────────────────────────

  // Toggle a mark like the main editor: a second press on **x** unwraps it.
  function wrapCmd(view: EditorView, from: number, to: number, before: string, after: string) {
    toggleWrap(view, from, to, before, after);
    view.focus();
    setToolbar(null);
  }

  function wrapSelection(before: string, after: string) {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    wrapCmd(view, from, to, before, after);
  }

  function commitTitle() {
    titleFocused.current = false;
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== (data.label as string)) onNodeTitleChange(id, trimmed);
  }


  // ⑦ web embed card: a note whose body is a single bare URL renders as an
  // embedded page (Obsidian-canvas-style) instead of a one-line link. Sites
  // that forbid framing (X-Frame-Options) show blank — the header's ↗ always
  // works; sandbox keeps the frame from navigating or touching the opener.
  const rawBody = draft.content.trim();
  const bareUrl = isHttpUrl(rawBody) && !/\s/.test(rawBody) ? rawBody : null;
  // Only trusted embed providers (YouTube / Vimeo, mediaEmbed.ts) frame on their
  // own; any other page is a link card until the person taps to load it, so
  // opening a board never makes requests to a stranger's server.
  const trustedEmbedSrc = bareUrl ? toEmbedUrl(bareUrl) : null;
  const bareUrlHost = (() => { try { return bareUrl ? new URL(bareUrl).hostname : null; } catch { return null; } })();

  // ⑨ media card: a note whose whole body is a single image renders as a
  // filled image (Heptabase/Miro-style), not a markdown preview clamped to a
  // few lines with the picture cut off; a single audio/video file (the
  // sidebar's audio/video notes) as a filled player. Double-click still drops
  // to the editor.
  const mediaCard = !bareUrl ? mediaOnlyCard(rawBody) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  // At the LOD threshold the card disappears completely — the parent section
  // shows a single big label instead. We return an empty placeholder rather
  // than null so React Flow keeps the node mounted (avoids selection churn).
  if (hiddenBySectionLOD) {
    return <div className="card-node card-node--section-hidden" />;
  }

  return (
    <div
      className={`card-node${selected ? " card-node--selected" : ""}${isEditing ? " card-node--editing" : ""}${titleOnly ? " card-node--title-only" : ""}${folded && !titleOnly ? " card-node--folded" : ""}${data.treeRoot ? " card-node--tree-root" : ""}${mediaCard || bareUrl ? " card-node--media" : ""}`}
      style={{ "--card-status-color": data.color as string | undefined, "--card-zoom": zoom, "--title-only-size": titleOnly ? `${titleCanvasPx(zoom)}px` : undefined, "--title-only-max-width": titleOnly ? `${(data.maxTitleWidth as number | undefined) ?? 0}px` : undefined } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={e => {
        e.stopPropagation();
        if (!titleOnly && !folded && !isEditing) setIsEditing(true);
      }}
    >
      <NodeResizer
        isVisible={(!!selected || hovered) && !folded && !titleOnly && !isEditing}
        minWidth={200} minHeight={60}
        // Quiet selection chrome: a hairline + small round corner grips. The
        // heavy dashed double-frame with 8 blocky handles read as CAD, not a
        // thinking board (死板 feedback).
        lineStyle={{ border: "1px solid color-mix(in srgb, var(--ac-accent) 55%, transparent)" }}
        handleStyle={{ width: 9, height: 9, borderRadius: 9, background: "var(--ac-surface)", border: "1.5px solid var(--ac-accent)" }}
        onResizeEnd={(_, bounds) => onNodeResized(id, bounds)}
      />

      {(["t","r","b","l"] as const).map(pos => (
        <Fragment key={pos}>
          <Handle key={`s-${pos}`} id={pos} type="source" position={{ t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left }[pos]} className="card-handle" />
          <Handle key={`t-${pos}`} id={pos} type="target" position={{ t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left }[pos]} className="card-handle" />
        </Fragment>
      ))}

      {branch && (
        <Pressable
          type="button"
          className="card-branch-toggle nodrag nopan"
          aria-expanded={branch.expanded}
          aria-label={branch.expanded ? tr("Hide sub-notes") : tr("Show sub-notes")}
          title={branch.expanded ? tr("Hide sub-notes") : tr("Show sub-notes")}
          onClick={(e) => { e.stopPropagation(); onToggleBranch(id); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {branch.expanded ? <ChevronLeft size={14} /> : <>{branch.below}<ChevronRight size={14} /></>}
        </Pressable>
      )}

      {titleOnly ? (
        // Far zoom: only the title, in a size that reads on screen. No body, no editor mounted.
        <Pressable
          type="button"
          className="card-node-title-only nodrag nopan"
          onClick={(e) => { e.stopPropagation(); onFocusCard(id); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >{titleDraft || tr("Untitled")}</Pressable>
      ) : (
      <>
      <div
        className="card-node-header"
        onPointerDownCapture={() => { heldWhenPressed.current = !!selected; }}
        onClick={() => { if (touchFirst && heldWhenPressed.current) titleInputRef.current?.focus(); }}
      >
        <span className="card-node-status-dot" />
        {data.sourceType === "ai" && (
          <span className="card-node-ai-badge" title={tr("AI generated")}>AI</span>
        )}
          <TextField
            ref={titleInputRef}
            className="card-node-title-input nodrag nopan"
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onFocus={() => { titleFocused.current = true; }}
            onBlur={commitTitle}
            onKeyDown={e => { e.stopPropagation(); if (isEnterKey(e)) e.currentTarget.blur(); }}
            onMouseDown={e => e.stopPropagation()}
          />
        {folded && <span className="card-node-fold-count">{tr("{n} paragraphs", { n: splitParagraphs(draft.content).length })}</span>}
        {/* Sub-canvas affordance (Heptabase-style nested whiteboard).
            • With subCanvasId: button opens the existing nested canvas.
            • Without: button is "Create sub-canvas" — only shown on hover/selected
              to keep the header clean for cards that don't use the feature. */}
        {data.subCanvasId ? (
          <Pressable
            className="card-node-subcanvas-btn card-node-subcanvas-btn--open nodrag"
            onClick={(e) => { e.stopPropagation(); onOpenSubCanvas(id); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={tr("Open nested whiteboard")}
            aria-label={tr("Open nested whiteboard")}
          >
            <LayoutDashboard size={11} />
          </Pressable>
        ) : ((selected || hovered) && (
          <Pressable
            className="card-node-subcanvas-btn card-node-subcanvas-btn--create nodrag"
            onClick={(e) => { e.stopPropagation(); onOpenSubCanvas(id); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={tr("Create nested whiteboard")}
            aria-label={tr("Create nested whiteboard")}
          >
            <Plus size={11} />
          </Pressable>
        ))}
        <Pressable
          type="button"
          className="card-node-fold-btn nodrag nopan"
          aria-expanded={!folded}
          aria-label={folded ? tr("Expand card") : tr("Fold card")}
          title={folded ? tr("Expand card") : tr("Fold card")}
          onClick={(e) => { e.stopPropagation(); onSetFolded(id, !folded); }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >{folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</Pressable>
      </div>

      {draft.status !== "idle" && (
        <div className="card-node-save-status nodrag nopan" role="status">
          <span>{tr(draft.status === "unsaved" ? "Unsaved card changes"
            : draft.status === "saving" ? "Saving card…" : "Card changes not saved")}</span>
          {draft.status === "rejected" && <Pressable type="button" onClick={e => { e.stopPropagation(); void draft.retry(); }}>{tr("Retry saving")}</Pressable>}
        </div>
      )}

      {!folded && (
        <div
          ref={bodyRef}
          className={`card-node-body nowheel${autoHeight && !isEditing ? " card-node-body--limited" : ""}${bodyClipped && !isEditing ? " card-node-body--clipped" : ""}${selected && !touchFirst ? " nodrag nopan" : ""}${isEditing ? " nodrag nopan card-node-body--editing" : ""}`}
          onKeyDown={e => e.stopPropagation()}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { void flushDraft(); setIsEditing(false); } }}
        >
          {/* Preview (non-editing). DELIBERATELY no math/mermaid/callouts:
              a canvas renders up to hundreds of these inline previews, and
              lazy-loading mermaid + KaTeX per card would be a perf
              regression. Open the node (editor preview / detail view) for
              the full-parity render. */}
          {!isEditing && bareUrl && (
            <div className="card-node-webembed nodrag">
              <div className="card-node-webembed-bar">
                <Globe size={11} />
                <span>{bareUrlHost ?? bareUrl}</span>
                <Link
                  href={bareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={tr("Open in new tab")}
                  onMouseDown={(e) => e.stopPropagation()}
                ><ExternalLink size={11} /></Link>
              </div>
              {trustedEmbedSrc ? (
                <iframe
                  src={trustedEmbedSrc}
                  title={bareUrlHost ?? tr("Web embed")}
                  sandbox={EMBED_IFRAME_SANDBOX}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : loadedUrl === bareUrl ? (
                <iframe
                  src={bareUrl}
                  title={bareUrlHost ?? tr("Web embed")}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="card-node-webembed-link">
                  <span className="card-node-webembed-url">{bareUrl}</span>
                  <Pressable
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setLoadedUrl(bareUrl)}
                  >{tr("Load preview")}</Pressable>
                </div>
              )}
            </div>
          )}
          {!isEditing && !bareUrl && mediaCard && (
            <div className={`card-node-image card-node-image--${mediaCard.kind} nodrag`}>
              {mediaCard.kind === "video" ? (
                <MediaPlayer kind="video" src={mediaCard.url} aria-label={mediaCard.alt || undefined} />
              ) : mediaCard.kind === "audio" ? (
                <MediaPlayer kind="audio" src={mediaCard.url} aria-label={mediaCard.alt || undefined} />
              ) : (
                <Img src={mediaCard.url} alt={mediaCard.alt} loading="lazy" referrerPolicy="no-referrer" draggable={false} />
              )}
            </div>
          )}
          {!isEditing && !bareUrl && !mediaCard && (
            <div ref={previewRef} className="card-node-preview card-md-preview">
              <MarkdownRenderer
                // Hundreds of cards render at once: mermaid stays code here.
                diagrams={false}
                // Likewise a step-by-step figure stays code on a card.
                steps={false}
                // A [[link]] opens from this card's note (its space decides
                // which same-titled note). No `nodes`: the label resolves on
                // click, not per card on every render.
                onNavigate={openCardLink}
                // Toggle the source task line and save through the existing
                // body-update path.
                onToggleTask={toggleCardTask}
              >
                {draft.content}
              </MarkdownRenderer>
            </div>
          )}

          {/* CodeMirror mount point. The EditorView itself is built lazily on
              entering edit mode (see the init effect) — the container is a cheap
              empty div until then, so a board of hundreds of cards pays for zero
              CodeMirror instances at rest. */}
          <div
            ref={cmContainer}
            className={`card-node-editor nodrag nopan${isEditing ? "" : " card-node-editor--hidden"}`}
          />

          {/* Formatting bubble */}
          {isEditing && toolbar && (
            <Popover popover={bubblePop} label={tr("Format selection")} role="toolbar" className="card-bubble-menu">
              <div className="card-bubble-row" onMouseDown={keepFocus}>
              <Pressable onMouseDown={e => { keepFocus(e); wrapSelection("**", "**"); }} title={tr("Bold")} aria-label={tr("Bold")}><Bold size={12} /></Pressable>
              <Pressable onMouseDown={e => { keepFocus(e); wrapSelection("*", "*"); }} title={tr("Italic")} aria-label={tr("Italic")}><Italic size={12} /></Pressable>
              <Pressable onMouseDown={e => { keepFocus(e); wrapSelection("~~", "~~"); }} title={tr("Strikethrough")} aria-label={tr("Strikethrough")}><Strikethrough size={12} /></Pressable>
              <Pressable onMouseDown={e => { keepFocus(e); wrapSelection("`", "`"); }} title={tr("Code")} aria-label={tr("Code")}><Code size={12} /></Pressable>
              </div>
            </Popover>
          )}
        </div>
      )}

      {!folded && bodyClipped && !isEditing && (
        <Pressable type="button" className="card-node-open-full nodrag nopan" onClick={(e) => { e.stopPropagation(); onOpenCard(id); }} onMouseDown={(e) => e.stopPropagation()}>
          {tr("Open full note")}
        </Pressable>
      )}
      </>
      )}
    </div>
  );
}
