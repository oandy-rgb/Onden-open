// Full-screen slides from a note's text (pages.ts), in a ui/Modal so it sits
// above anything open (a dialog it was played from) and keeps focus inside. It
// draws the same SlideView as the note's 「簡報」 tab, with the layouts and theme
// chosen there (`data`), so what was seen is what is played. ← → / Space / Page keys
// and a horizontal swipe change slides, Esc leaves. Each slide's footer names
// the sources its [n] markers cite; choosing one leaves the deck and opens
// that note.
import { anchorSpansOf, anchorsVersion, watchAnchors } from "../../lib/blockAnchorStore";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SlidesData } from "@onden/markdown";
import { Modal, CloseButton, Pressable } from "../../components/ui";
import { getAppState } from "../../lib/appStore";
import { usePresentLandscape } from "../../hooks/usePresentLandscape";
import { useT } from "../../lib/i18n";
import { resolveWikilink, type WikilinkSource } from "../../lib/wikilinks";
import { layoutOfPage, pagesOf } from "./pages";
import SlideView from "./SlideView";
import { slideRenderer } from "./slideRender";
import { useDeckLook } from "./theme";
import type { DeckSource } from "./slides";
import "./i18n";
import "./presentation.css";

/** A horizontal move longer than this (px) on release is a swipe. */
const SWIPE = 48;

/** Digits typed for 「到第 N 頁」 are forgotten after this long without another key. */
const NUMBER_FORGET_MS = 2000;
/** Page numbers have at most this many digits; more are ignored. */
const MAX_DIGITS = 4;

export default function PresentationPlayer({ markdown, title, from, data, startAt = 0, onPage, onClose, onOpenNode }: {
  markdown: string;
  title: string;
  /** The note's chosen layouts and theme (its `slides_data`); left out: every page by its own content, the website's look. */
  data?: SlidesData;
  /** The page to start on. */
  startAt?: number;
  /** Told the page's key and place on opening and at every change: the note's tab returns to the page last seen. */
  onPage?: (pageKey: string, index: number) => void;
  /** The note the deck is played from: its [[links]] resolve within its space. */
  from?: WikilinkSource | null;
  onClose: () => void;
  /** Open a note in the app (after the deck has closed). */
  onOpenNode?: (id: string) => void;
}) {
  const t = useT();
  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the held anchors change with `anchorsSeen`
  const pages = useMemo(() => pagesOf(markdown, from?.id ? anchorSpansOf(from.id, markdown) : []), [markdown, from?.id, anchorsSeen]);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startAt), pages.length - 1));
  const { vars } = useDeckLook(data?.theme ?? "site");
  const root = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const nodes = getAppState().data.nodes;
  const last = pages.length - 1;
  const turnPhone = usePresentLandscape(true);
  // Digits typed so far for a page jump ("" when none), forgotten after NUMBER_FORGET_MS.
  const [typed, setTyped] = useState("");
  const typedRef = useRef("");
  const forget = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setNumber = (next: string) => {
    typedRef.current = next;
    setTyped(next);
    clearTimeout(forget.current);
    if (next) forget.current = setTimeout(() => setNumber(""), NUMBER_FORGET_MS);
  };
  useEffect(() => () => clearTimeout(forget.current), []);
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const pageKey = pages[index]?.key;
  useEffect(() => { if (pageKey !== undefined) onPageRef.current?.(pageKey, index); }, [pageKey, index]);
  const go = (delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta)));

  function openNote(id: string | null) {
    onClose();
    if (id) onOpenNode?.(id);
  }
  const nodeFor = (source: DeckSource) => {
    if (!source.target) return null;
    return resolveWikilink(source.target, from, nodes);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    // Esc is the Modal's (it asks to close). A modifier pressed alone is not a key press of its own.
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    // A page number: digits, then Enter. No text field exists here, so digits are page numbers even with a button
    // focused (after a click on 「下一頁」); the typed number wins over the button's own Enter. Any other key
    // forgets the digits and does its own work.
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); if (typedRef.current.length < MAX_DIGITS) setNumber(typedRef.current + e.key); return; }
    if (typedRef.current) {
      const number = Number(typedRef.current);
      setNumber("");
      if (e.key === "Enter") { e.preventDefault(); setIndex(Math.min(last, Math.max(0, number - 1))); return; }
    }
    // Enter / Space on a button press it.
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement) return;
    if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
    else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
    else if (e.key === "End") { e.preventDefault(); setIndex(last); }
  }

  // Esc (the Modal's close request) first forgets typed digits; the next one leaves.
  const leave = () => { if (typedRef.current) setNumber(""); else onClose(); };
  const page = pages[index];
  const render = useMemo(() => slideRenderer(nodes, from, (id) => openNote(id)), [nodes, from]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal label={t("Presenting “{title}”", { title })} className="presentation-layer" onClose={leave} initialFocus={root}>
    <div
      ref={root}
      className="presentation"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { if (e.isPrimary) swipe.current = { x: e.clientX, y: e.clientY }; }}
      onPointerUp={(e) => {
        const start = swipe.current;
        swipe.current = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(e.clientY - start.y)) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="presentation-stage" aria-live="polite">
        <SlideView page={page} layout={layoutOfPage(page, data?.layouts ?? {})} vars={vars} render={render} />
      </div>
      {turnPhone && <p className="presentation-rotate" role="status">{t("Turn your phone sideways to read the slides.")}</p>}
      {page.cites.length > 0 && (
        <p className="presentation-sources">
          {page.cites.map((source, i) => {
            const node = nodeFor(source);
            return (
              <span key={source.n}>
                {i > 0 && " · "}
                {node
                  ? <Pressable type="button" onClick={() => openNote(node.id)}>[{source.n}] {source.label}</Pressable>
                  : <span>[{source.n}] {source.label}</span>}
              </span>
            );
          })}
        </p>
      )}
      {typed && <p className="presentation-goto" role="status">{t("Go to slide {n}", { n: Math.min(pages.length, Math.max(1, Number(typed))) })}</p>}
      <div className="presentation-bar">
        <Pressable type="button" aria-label={t("Previous slide")} disabled={index === 0} onClick={() => go(-1)}><ChevronLeft size={18} /></Pressable>
        <span className="presentation-count">{index + 1} / {pages.length}</span>
        <Pressable type="button" aria-label={t("Next slide")} disabled={index === last} onClick={() => go(1)}><ChevronRight size={18} /></Pressable>
        <CloseButton className="presentation-exit" label={t("Leave the slides")} onClick={onClose} />
      </div>
    </div>
    </Modal>
  );
}
