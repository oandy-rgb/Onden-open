import { setEmbeddedTaskDone } from "../lib/embedTasks";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { copyText } from "../lib/clipboard";
import { useTransientFlag } from "../hooks/useTransientFlag";
import "../styles/calloutColors.css";
import "./MarkdownRenderer.css";
import "../styles/published-site.css";
import {
  ondenMarkdownCore, litePlaySrc, SAFE_DATA_MEDIA_SRC, isAllowedEmbedSrc, liteEmbedOf, liteEmbedFrameHtml, toEmbedUrl, classifyMedia, EMBED_IFRAME_ATTRS, rehypeMediaSvgLinks, headingFragment,
  STEPS_LANG, markdownNeeds, withEmbedded, loadEnhancers, enhancersFor, embedBodyOfSrc, frozenQueryBlock, isQueryBlockLang, nodeRefId,
  type FrozenQueryBlock, type MarkdownProfile, type MarkdownEnhancers, type MarkdownNeeds, type GrammarName, type LoadedEnhancers,
  handwritingPageNumber,
} from "@onden/markdown";
import { Suspense, createContext, use, useContext, type ComponentProps, type ComponentType, useCallback, useMemo, useRef, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { anchorSpansOf, anchorsVersion, watchAnchors } from "../lib/blockAnchorStore";
import { MediaPlayer } from "./MediaPlayer";
import { lazyWithReload } from "../lib/lazyWithReload";

// The live query block reads through the app's data layer (writers, write
// queue, local DB); only the app profile mounts it. Loaded on first use so the
// published site (frozen results, D113) never downloads that layer.
// 「可能在這裡 / 就是這段」、「段落已不存在」、已刪除的段落: loaded only when a link is in one of those states.
const PartLinkNote = lazyWithReload(() => import("./PartLinkNote"));
const OndenQueryBlock = lazyWithReload(() => import("./OndenQueryBlock"));
// Likewise the base block (BaseRenderer reads the app store).
const OndenBaseBlock = lazyWithReload(() => import("./OndenBaseBlock"));
// The step-by-step figure and its player: a note without one never loads them.
const StepsFigure = lazyWithReload(() => import("./StepsFigure"));

import FrozenQueryResult from "./FrozenQueryResult";
import { classNames } from "../lib/utils";
import { resolveWikilink, type WikilinkNode, type WikilinkSource } from "../lib/wikilinks";
import { loadedPartLinks, usePartLinks } from "../lib/partLinkModule";
import { setPendingCursor } from "../lib/cursorHandoff";
import { embedSourceVersion, resolveEmbed, taskVersion } from "../lib/embeds";
import { resolveTaskRef, taskRefById, useTaskRefs } from "../lib/taskRefs";
import { getLocale, useT } from "../lib/i18n";
import { Pressable, Img, Link } from "./ui";
import type { StepsFigureProps, StepsLabels } from "./StepsFigure";
import { observeRootAttributes, rootAttribute } from "../lib/documentAccess";
import { matchesMedia } from "../lib/mediaQuery";
// Minimal shape required for wiki-link resolution — compatible with both
// ContentNode and PublishedNode (lib/wikilinks).
type LinkNode = WikilinkNode;

// Extract the raw text of a rendered code block from react-markdown's
// `pre` children (a single `<code>` element whose children are the text).
function codeTextOf(node: ReactNode): string {
  let out = "";
  const walk = (n: ReactNode): void => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out += String(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { props?: { children?: ReactNode } };
    if (el.props) walk(el.props.children);
  };
  walk(node);
  return out.replace(/\n$/, "");
}

// Langs the `code` override turns into their own custom elements (not a plain
// <code>); a <pre> wrapping one of these must NOT get a copy button. mermaid is
// custom only when diagrams are drawn (otherwise it renders as plain code).
function customBlockLang(lang: string, mermaidOn: boolean): boolean {
  return isQueryBlockLang(lang) || (mermaidOn && lang === "mermaid");
}

/** The text of the ```mermaid block a `pre` holds (react-markdown's hast `node`), else null. */
function mermaidBlockSource(node: unknown): string | null {
  const code = (node as { children?: Array<{ properties?: { className?: string[] }; children?: Array<{ value?: string }> }> } | undefined)?.children?.[0];
  return code?.properties?.className?.includes("language-mermaid") ? (code.children?.[0]?.value ?? "").replace(/\n$/, "") : null;
}

/** The language of a `pre` override's code child (react-markdown hands it the raw props). */
function preLang(children: ReactNode): string {
  const onlyChild = Array.isArray(children) ? children[0] : children;
  const cls = (onlyChild as { props?: { className?: unknown } })?.props?.className;
  return typeof cls === "string" ? /language-([\w-]+)/.exec(cls)?.[1] ?? "" : "";
}

// Wraps a rendered code block (<pre>) and adds a small, on-brand
// copy-to-clipboard button that briefly shows a "Copied" state.
function CodeBlock(
  { children, node: _node, mermaidOn, published, stepsOn, ...rest }:
  { children?: ReactNode; node?: unknown; mermaidOn: boolean; published: boolean; stepsOn: boolean } & Record<string, unknown>,
) {
  const t = useT();
  const [copied, flashCopied] = useTransientFlag();
  const preRef = useRef<HTMLPreElement>(null);
  // react-markdown hands the `pre` override the RAW child props (className +
  // hast node), NOT the rendered `code` element — so detect plain code by the
  // child's `language-*` class and exclude the langs the `code` override turns
  // into custom blocks (onden-query / onden-base / mermaid).
  const lang = preLang(children);
  const isPlainCode = !customBlockLang(lang, mermaidOn);
  // A frozen query result is a list or a table, not preformatted text.
  if (published && isQueryBlockLang(lang)) return <>{children}</>;
  // A steps figure is its own block, not preformatted text.
  if (stepsOn && lang === STEPS_LANG) return <>{children}</>;
  if (!isPlainCode) return <pre {...rest}>{children}</pre>;
  const handleCopy = () => {
    // Prefer the rendered text (handles highlighted spans); fall back to the
    // DOM textContent so it works even if children shape changes.
    const text = codeTextOf(children) || preRef.current?.textContent?.replace(/\n$/, "") || "";
    void copyText(text, { successToast: false }).then((ok) => { if (ok) flashCopied(); });
  };
  return (
    <div className="md-codeblock">
      <Pressable
        type="button"
        className="md-codeblock-copy"
        onClick={handleCopy}
        aria-label={copied ? t("Copied") : t("Copy code")}
        title={copied ? t("Copied") : t("Copy code")}
      >
        {copied ? t("Copied") : t("Copy")}
      </Pressable>
      <pre {...rest} ref={preRef}>{children}</pre>
    </div>
  );
}

// Is the diagram being rendered inside a dark surface? The app flips
// `[data-theme="dark"]` on <html>; fall back to the OS preference for an unset
// 3-way theme.
function mermaidContextDark(): boolean {
  const attr = rootAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return matchesMedia("(prefers-color-scheme: dark)");
}

function MermaidBlock({ code }: { code: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [dark, setDark] = useState(false);
  // Track the effective theme so the diagram matches the page, and re-render
  // when it changes (editor theme switch) — the render effect below only
  // re-runs when `code` or `dark` changes.
  useEffect(() => {
    const update = () => setDark(mermaidContextDark());
    update();
    return observeRootAttributes(["data-theme", "class"], update);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!ref.current) return;
      try {
        const mermaid = (await import("mermaid")).default;
        // securityLevel:"strict" — the published site is a public surface, so
        // sanitize diagram labels (no raw HTML / click-binding from source md).
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void render();
    return () => { cancelled = true; };
  }, [code, dark]);
  if (failed) return <p className="md-mermaid-error">{t("This diagram has a syntax error and can't be drawn.")}</p>;
  return <div ref={ref} className="md-mermaid" />;
}

// Renders a trusted YouTube/Vimeo embed as a sandboxed iframe in a responsive
// wrapper. The host gate (isAllowedEmbedSrc) is applied by every caller before
// reaching here, but we re-check defensively — never frame an untrusted host.
function EmbedIframe({ src, title }: { src: string; title?: string }) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  if (!isAllowedEmbedSrc(src)) return null;
  const label = title ?? t("Embedded media");
  const lite = liteEmbedOf(src);
  // A span, as in the exports (htmlUtils): it sits inside the paragraph the
  // link was in; the stylesheet makes it a block.
  if (!lite || playing) {
    return (
      <span className="md-embed md-embed-iframe">
        <iframe src={playing ? litePlaySrc(src) : src} title={label} {...EMBED_IFRAME_ATTRS} />
      </span>
    );
  }
  // Click to load (liteEmbed.ts): a thumbnail that is a link to the video until
  // pressed. The published pages' script (mediaEnhance.ts) does the same swap.
  return (
    <span className="md-embed md-embed-lite">
      <Link
        className="md-lite-link" href={lite.watchUrl} target="_blank" aria-label={label}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setPlaying(true);
        }}
      >
        {lite.thumbUrl
          ? <Img className="md-lite-thumb" src={lite.thumbUrl} alt="" />
          : <span className="md-lite-host">{lite.host}</span>}
        <span className="md-lite-play" aria-hidden="true" />
      </Link>
      {/* The iframe the published pages' script brings in on a press (inert here: the app swaps it itself). */}
      <template dangerouslySetInnerHTML={{ __html: liteEmbedFrameHtml(lite, label) }} />
    </span>
  );
}

// A `![[…]]` embed (lib/embeds): resolved against the note's links, drawn
// into its own element by lib/embedDom — lazily, the same renderer the
// editor's widgets use. A span: it sits where react-markdown put the image,
// inside a paragraph; the stylesheet makes it a block.
function EmbedBlock({ body, from, nodes, onNavigate }: {
  body: string; from?: WikilinkSource | null; nodes?: LinkNode[];
  onNavigate?: MarkdownRendererProps["onNavigate"];
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const fromId = from?.id;
  const fromSpace = from?.space_id;
  // The tasks the reader holds are part of what an embed can name (lib/taskRefs).
  const tasks = useTaskRefs();
  // `![[筆記/段落]]` reads through the part-link module once it is loaded (the renderer around it loads it, lib/partLinkModule, and draws again).
  const partLinks = loadedPartLinks();
  const embed = useMemo(() => resolveEmbed(body, { id: fromId, space_id: fromSpace }, nodes, tasks), [body, fromId, fromSpace, nodes, tasks, partLinks]); // eslint-disable-line react-hooks/exhaustive-deps -- resolveEmbed reads the module through loadedPartLinks()
  // Re-render only when what is shown changes, not on every new nodes array.
  // The source's text is part of it: a changed source (sync, local edit) redraws.
  const key = embed.kind === "missing" ? `missing:${body}`
    : embed.kind === "task" ? `task:${body}:${embed.task ? taskVersion(embed.task) : "none"}`
    : `${embed.kind}:${embed.node.id}:${embed.node.title}:${body}:${embedSourceVersion(embed.node)}`;
  const navigate = useRef(onNavigate);
  useEffect(() => { navigate.current = onNavigate; });
  const embedRef = useRef(embed);
  embedRef.current = embed;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const fromRef = useRef<WikilinkSource>({ id: fromId, space_id: fromSpace });
  fromRef.current = { id: fromId, space_id: fromSpace };
  useEffect(() => {
    if (!ref.current) return;
    const current = embedRef.current;
    // embedDom reads the data layer; the app profile loads it on first embed
    // so the published site (which never draws embeds) does not.
    const el = ref.current;
    let cancelled = false;
    let unmount: (() => void) | undefined;
    void import("../lib/embedDom").then(({ mountEmbed }) => {
      if (cancelled) return;
      unmount = mountEmbed(el, current, {
        nodes: nodesRef.current,
        from: fromRef.current,
        setTaskDone: setEmbeddedTaskDone,
        onOpen: navigate.current && ((nodeId, blockId) => {
          // The note opened is not always the one the embed names: a block that
          // moved opens the note that holds it (lib/blockHome).
          navigate.current?.(nodesRef.current?.find((n) => n.id === nodeId)?.slug ?? "", nodeId, blockId);
        }),
      });
    });
    return () => { cancelled = true; unmount?.(); };
  }, [key]);
  return <span ref={ref} className="md-embed-block" data-embed={body} />;
}

export type MarkdownRendererProps = {
  children: string;
  nodes?: LinkNode[];
  /** The note this markdown belongs to: a [[title]] resolves within its
   *  space (lib/wikilinks). Omitted on the published site. */
  from?: WikilinkSource | null;
  // Called when a [[wikilink]] is clicked: (target's slug, target's id) when
  // it resolved, (the link's label, null) when it did not.
  // Optional blockId (W2 P2) is provided when the source was [[note#^id]],
  // heading when it was [[note#Heading]] (as written: the host finds it in
  // the target's text with headingFragment); consumers can use them to
  // scroll to that place in the target node.
  onNavigate?: (slug: string, nodeId: string | null, blockId?: string, heading?: string) => void;
  // Optional image URL resolver (e.g. for relative media paths in published site)
  resolveImage?: (src: string) => string;
  /** Which surface this is (see @onden/markdown): "app" parses a note's
   *  inline HTML (sanitized); "published" — the public site and what is
   *  exported from it — shows it as text. Everything else renders the same. */
  profile?: MarkdownProfile;
  /** The words of the footnote section for the published profile (the site's language, from its
   *  locale); without them the published pages would say "Footnotes" in English whatever the site speaks. */
  footnoteLabels?: { heading: string; back: (referenceNumber: number) => string };
  /** The alt of a handwriting page of a published note (page number → words in the
   *  site's language). The page is the image whose address carries the mark the
   *  publisher writes (@onden/markdown handwritingPageNumber): it is drawn as a
   *  sheet (`md-image--ink-page`) and given this alt. Without it every image
   *  is an ordinary one, so the app profile never treats an address as a page. */
  handwritingAlt?: (page: number) => string;
  /** The paragraphs of this text that carry an anchor (`data-block-id` on them: what an embed or link scrolls to). The app
   *  reads them from the anchors it holds for `from`'s note; the published site gives the page's own. */
  blockAnchors?: ReadonlyArray<{ id: string; from: number; to: number }>;
  /** The published profile's onden-query / onden-base results: the note's
   *  blocks frozen when it was published (D113, @onden/markdown
   *  queryBlocks.ts). The published profile draws these and never mounts the
   *  live query components; a block without one shows that its results are
   *  not included. Ignored by the app profile, which runs the queries live. */
  queryBlocks?: readonly FrozenQueryBlock[];
  /** Draw ```steps blocks as a step-by-step figure (default). Off where
   *  hundreds render at once (canvas cards), where they stay code. The
   *  published profile draws one only with `stepsView`. */
  steps?: boolean;
  /** The figure's component, for the published profile (the site renders it
   *  without lazy loading, which a server render cannot wait for). The app
   *  profile loads its own on first use. */
  stepsView?: ComponentType<StepsFigureProps>;
  /** The player's words; the app's own translations without it. */
  stepsLabels?: StepsLabels;
  /** Read `$…$` as math (default). Off for text not written in Onden (an
   *  RSS article), where dollar signs are prices. */
  math?: boolean;
  /** A ```mermaid block's drawing from its text, made ahead of time (the
   *  published site's diagrams laid out at publish time); null: no drawing,
   *  the block is drawn by `diagrams` or stays code. Keep it referentially stable. */
  diagramFor?: (source: string) => ReactNode | null;
  /** Draw ```mermaid blocks as diagrams (lazy-loads mermaid). Off only where
   *  hundreds render at once (canvas cards), where they stay code. */
  diagrams?: boolean;
  // CSS class variant for inline wikilinks
  linkStyle?: "editor" | "published";
  /** The published profile's wikilinks as real `<a href>` (the static site: a
   *  link must open in a new tab, be copied and be followed by a crawler)
   *  instead of buttons that call `onNavigate`. Gets the resolved target and
   *  returns its address; null (an unresolved link) draws plain text. Keep it
   *  referentially stable — it is a render dependency. */
  linkHref?: (target: { id: string; slug: string }, blockId?: string, heading?: string) => string | null;
  // When provided, rendered GFM task checkboxes become interactive: toggling
  // one calls back with the checkbox's 0-based document-order index, so the
  // caller can flip the source `[ ]`↔`[x]` line (see lib/taskCheckbox) and save
  // through the existing body-update path. Omit for read-only surfaces.
  onToggleTask?: (checkboxIndex: number) => void;
  /** Static output (an RSS body, rendered with renderToStaticMarkup): no
   *  interactive controls, so a code block has no copy button. */
  static?: boolean;
};


// KaTeX and the code grammars load when a note needs them (@onden/markdown
// lazy.ts), not with the app. In the browser the note renders at once —
// code plain, math as its source — and again when they arrive. A note
// rendered on the server (the published site's pages, which preload them
// all) instead suspends its hydration until they have loaded here too, so
// the browser's first render matches the server's HTML.
const noSubscribe = () => () => {};
const NO_EXTRA: { grammars: GrammarName[]; detect: boolean } = { grammars: [], detect: false };
const needsKey = (needs: MarkdownNeeds) => `${needs.math}|${needs.detect}|${needs.grammars.join(",")}|${needs.unresolved?.join(",") ?? ""}`;

function useMarkdownEnhancers(source: string, math: boolean) {
  // True on the server and while hydrating its HTML; kept for the renderer's
  // life, so it doesn't remount once hydration is over.
  const serverRendered = useSyncExternalStore(noSubscribe, () => false, () => true);
  const [suspense] = useState(serverRendered);
  // Blocks the source scan can't see (an indented code block, a <pre> in
  // HTML) are reported by the highlighter while rendering, then loaded.
  const [extra, setExtra] = useState(NO_EXTRA);
  const missed = useRef({ grammars: new Set<GrammarName>(), detect: false });
  missed.current = { grammars: new Set(), detect: false };
  const onMissing = useCallback((need: GrammarName | "detect") => {
    if (need === "detect") missed.current.detect = true;
    else missed.current.grammars.add(need);
  }, []);
  const needs = useMemo<MarkdownNeeds>(() => {
    const scanned = markdownNeeds(source, { math });
    return {
      math: scanned.math,
      grammars: withEmbedded([...scanned.grammars, ...extra.grammars]),
      detect: scanned.detect || extra.detect,
      unresolved: scanned.unresolved,
    };
  }, [source, math, extra]);
  const key = needsKey(needs);
  const [loads, setLoads] = useState(0);
  // `loads` and `key` stand for `needs`: recomputed when a load lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loaded = useMemo(() => enhancersFor(needs, onMissing), [key, loads, onMissing]);
  // What the last render reported; `needs` is a new object whenever the
  // source changes, so this runs after every render that could report more.
  useEffect(() => {
    const more = [...missed.current.grammars].filter((g) => !needs.grammars.includes(g));
    const detect = missed.current.detect && !needs.detect;
    if (more.length || detect) setExtra((e) => ({ grammars: [...e.grammars, ...more], detect: e.detect || detect }));
  }, [needs]);
  useEffect(() => {
    if (loaded.ready) return;
    let live = true;
    void loadEnhancers(needs).then(() => { if (live) setLoads((n) => n + 1); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded.ready]);
  return { needs, loaded, suspense, onMissing };
}

/** Renders once what `needs` asks for has loaded; suspends until then. */
function WhenLoaded({ needs, loaded, onMissing, render }: {
  needs: MarkdownNeeds; loaded: LoadedEnhancers; onMissing: (need: GrammarName | "detect") => void;
  render: (enhancers: MarkdownEnhancers) => ReactNode;
}) {
  if (loaded.ready) return render(loaded.enhancers);
  use(loadEnhancers(needs));
  return render(enhancersFor(needs, onMissing).enhancers);
}

// <audio>/<video> keep playing only while React keeps the same element. The
// `components` map below is rebuilt whenever `nodes`, `tasks` or a callback
// changes (every sync and autosave), and react-markdown uses each entry as an
// element type — a new function there unmounts the player and playback resets.
// So these entries are module-level (stable type); whatever they need from the
// renderer's props arrives through context, which re-renders without remounting.
function MdVideo({ src, poster, children }: ComponentProps<"video">) {
  return <MediaPlayer kind="video" className="md-video" src={src} poster={poster}>{children}</MediaPlayer>;
}
function MdAudio({ src, children }: ComponentProps<"audio">) {
  return <MediaPlayer kind="audio" className="md-audio" src={src}>{children}</MediaPlayer>;
}

type ImageEnv = {
  from?: WikilinkSource | null; nodes?: LinkNode[];
  onNavigate?: MarkdownRendererProps["onNavigate"];
  resolveImage?: MarkdownRendererProps["resolveImage"];
  handwritingAlt?: MarkdownRendererProps["handwritingAlt"];
};
const ImageEnvContext = createContext<ImageEnv>({});

/** `![alt](url)`: an embed, a media player, or a normal image (see `img` below). */
function MdImage({ src, alt }: ComponentProps<"img">) {
  const { from, nodes, onNavigate, resolveImage, handwritingAlt } = useContext(ImageEnvContext);
  const embedBody = embedBodyOfSrc(src);
  if (embedBody !== null) {
    return <EmbedBlock body={embedBody} from={from} nodes={nodes} onNavigate={onNavigate} />;
  }
  const raw = src ?? "";
  const resolved = resolveImage ? resolveImage(raw) : raw;
  const kind = classifyMedia(raw);
  if (kind === "video") return <MdVideo src={resolved} />;
  if (kind === "audio") return <MdAudio src={resolved} />;
  if (kind === "iframe") {
    const embed = toEmbedUrl(raw);
    if (embed) return <EmbedIframe src={embed} title={alt || undefined} />;
  }
  const page = handwritingAlt ? handwritingPageNumber(raw) : null;
  if (page !== null) return <Img src={resolved} alt={handwritingAlt!(page)} className="md-image md-image--ink-page" loading="lazy" />;
  return <Img src={resolved} alt={alt ?? ""} className="md-image" loading="lazy" />;
}

export default function MarkdownRenderer({
  children,
  nodes,
  from,
  onNavigate,
  resolveImage,
  handwritingAlt,
  profile = "app",
  footnoteLabels,
  queryBlocks,
  blockAnchors: givenAnchors,
  math = true,
  diagrams: enableMermaid = true,
  diagramFor,
  steps: stepsRequested = true,
  stepsView,
  stepsLabels,
  linkStyle = "editor",
  linkHref,
  onToggleTask,
  static: isStatic = false,
}: MarkdownRendererProps) {
  // Document-order counter for GFM task checkboxes. react-markdown renders the
  // `input` components in document order within a single render pass; we reset
  // the counter on each render so the Nth checkbox gets index N, matching the
  // Nth task line found by lib/taskCheckbox#toggleTaskLine.
  const checkboxIndex = useRef(0);
  checkboxIndex.current = 0;
  const t = useT(); // re-render on a language switch (footnote wording)
  const locale = getLocale();
  // Primitive deps: callers pass `from` as an inline object.
  const fromId = from?.id;
  const fromSpace = from?.space_id;
  // The text being rendered, for a same-note [[#Heading]] (read while the
  // pipeline runs, inside this render).
  const text = useRef(children);
  text.current = children;
  const { needs, loaded, suspense, onMissing } = useMarkdownEnhancers(children, math);
  const linksOn = nodes !== undefined || !!onNavigate;
  const stepsOn = stepsRequested && (stepsView !== undefined || profile === "app");
  // A step's text is drawn by this same renderer, with the page's links and
  // media, but not as another figure and without task toggles (their index
  // would not match the note's).
  const stepBody = useRef<MarkdownRendererProps | null>(null);
  stepBody.current = { nodes, from, onNavigate, resolveImage, handwritingAlt, profile, footnoteLabels, queryBlocks, blockAnchors: givenAnchors, math, diagrams: enableMermaid, steps: false, linkStyle, linkHref, static: isStatic, children: "" };
  const renderStepBody = useCallback((markdown: string) => <MarkdownRenderer {...stepBody.current!}>{markdown}</MarkdownRenderer>, []);
  const figureLabels = useMemo<StepsLabels>(() => stepsLabels ?? {
    prev: t("Previous step"), next: t("Next step"), expand: t("Show all steps"), collapse: t("One step at a time"), count: t("Step {n} of {m}"),
  }, [stepsLabels, t]);
  // Task links resolve against the tasks the reader holds (lib/taskRefs).
  const tasks = useTaskRefs();
  // A part link `[[筆記/段落]]` reads from the anchors and bindings the sync brought (loaded when the text may hold one).
  const partLinks = usePartLinks(text.current, profile === "app" && linksOn);
  // Which paragraphs carry an anchor: the given ones (the published page's), else this note's as the sync brought them.
  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  const blockAnchors = useMemo(
    () => givenAnchors ?? (profile === "app" && fromId ? anchorSpansOf(fromId, children) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the held anchors change with `anchorsSeen`
    [givenAnchors, profile, fromId, children, anchorsSeen],
  );
  const options = useMemo<Parameters<typeof ondenMarkdownCore>[0]>(() => ({
    profile,
    math,
    blockAnchors,
    // `![[…]]` embeds draw in the app (EmbedBlock). The published site's
    // come from the server, already as pictures or placeholders.
    embeds: profile === "app" && linksOn,
    // The published site's chrome speaks the site's language, not the app's (makeSiteMarkdown passes it).
    footnoteLabels: profile === "app" ? { heading: t("Footnotes"), back: (n) => t("Back to reference {n}", { n }) } : footnoteLabels,
    // Every wikilink href carries a `#wl:` sentinel that the `a` renderer
    // below keys on (the plugin's className does not survive sanitize). An
    // UNRESOLVED link still links — to its label, styled un-`known` — so a
    // click can CREATE the note, the Obsidian beat. A RESOLVED link carries
    // the target's id, not its slug: slugs are unique per space only. A
    // `?bid=` query carries a `#^block` reference, `?h=` a `#Heading` (a `#`
    // would be taken by the browser). A same-note `[[#Heading]]` is a plain
    // in-page link to the heading's anchor.
    wikilinkLabel: linksOn && profile === "app"
      ? (body) => {
          const ctx = { nodes, from: { id: fromId, space_id: fromSpace } };
          return partLinks ? partLinks.partLinkWords(body, ctx) ?? partLinks.legacyBlockWords(body, { ...ctx, selfMarkdown: text.current }) : null;
        }
      : undefined,
    wikilinkHref: linksOn
      ? ({ target, blockId, heading }) => {
          if (target === "" && heading) {
            const fragment = headingFragment(text.current, heading);
            if (fragment) return fragment;
          }
          // `[[筆記/段落開頭]]`: the note, with where in it the part is (`?at=`); a part that is gone or not ours to see has no way in.
          const read = partLinks?.readPartLink(target, { nodes, from: { id: fromId, space_id: fromSpace } });
          const part = partLinks && read ? partLinks.partLinkHref(read) : null;
          if (part) return part;
          // Empty target is a same-note `[[#^id]]` (the old form; `id` is the paragraph's anchor id).
          const found = target === "" ? null : resolveWikilink(target, { id: fromId, space_id: fromSpace }, nodes)
            ?? resolveTaskRef(target, tasks);
          const base = found ? found.id : target;
          return blockId ? `#wl:${base}?bid=${blockId}` : heading ? `#wl:${base}?h=${encodeURIComponent(heading)}` : `#wl:${base}`;
        }
      : undefined,
  }), [profile, math, blockAnchors, nodes, tasks, fromId, fromSpace, linksOn, locale, partLinks]); // eslint-disable-line react-hooks/exhaustive-deps -- t() reads the current locale

  const components = useMemo<Parameters<typeof ReactMarkdown>[0]["components"]>(() => ({
    a: ({ href, id, className: cls, children: ch }) => {
      // Wikilinks are tagged by a `#wl:` href sentinel (pageResolver), NOT by
      // className — rehype-sanitize strips the plugin's class in the raw
      // pipeline that preview/published use, so a class-based check rendered a
      // dead <a> the click never reached. The sentinel survives sanitize.
      const clsRaw = cls as unknown;
      const clsStr = typeof clsRaw === "string" ? clsRaw : Array.isArray(clsRaw) ? clsRaw.join(" ") : "";
      // A part link whose paragraph is gone (its old words struck through) or whose note is not this reader's.
      if ((href ?? "").startsWith("#wl-gone:")) {
        return <Suspense fallback={null}><PartLinkNote gone={decodeURIComponent((href ?? "").slice("#wl-gone:".length))}>{ch}</PartLinkNote></Suspense>;
      }
      const isWiki = (href ?? "").startsWith("#wl:");
      // A same-note [[#Heading]] keeps the plugin's class but is an in-page
      // `#fragment` (below).
      if ((isWiki || (clsStr.includes("internal") && !(href ?? "").startsWith("#"))) && onNavigate) {
        // Strip the sentinel, then decode an optional `?bid=` block-reference
        // (W2 P2) or `?h=` heading suffix. The base is the resolved target's
        // id, or the label of an unresolved link; the block id / heading is
        // forwarded to onNavigate so the caller can scroll-to-anchor.
        const rawPayload = isWiki ? (href ?? "").slice("#wl:".length) : (href ?? "");
        // `?at=` (a part link): where in the note the part is; opening it puts the caret there.
        const tail = (isWiki && partLinks?.partLinkTail(rawPayload)) || { base: rawPayload, at: null, maybe: null, lost: null };
        const payload = tail.base;
        const bidIdx = payload.indexOf("?bid=");
        const hIdx = bidIdx >= 0 ? -1 : payload.indexOf("?h=");
        const base = bidIdx >= 0 ? payload.slice(0, bidIdx) : hIdx >= 0 ? payload.slice(0, hIdx) : payload;
        const blockId = bidIdx >= 0 ? payload.slice(bidIdx + "?bid=".length) : undefined;
        const heading = hIdx >= 0 ? decodeHeading(payload.slice(hIdx + "?h=".length)) : undefined;
        // Opened by id: no second lookup by slug that could land on another
        // space's same-slug note.
        const node = nodes?.find(isWiki ? (n => n.id === base) : (n => n.slug === base)) ?? null;
        const task = isWiki && !node && linkStyle !== "published" ? taskRefById(base, tasks) : null;
        // A link that names a task by id the reader does not hold (no permission,
        // or gone): no title, no way in — never the text the note's author typed.
        if (isWiki && !node && !task && linkStyle !== "published" && nodeRefId(base)) {
          return <span className="wikilink-token wikilink-token--unavailable">{t("Content you cannot access")}</span>;
        }
        const slugOnly = node ? node.slug : task ? task.slug : base;
        const known = !nodes || node !== null || task !== null;
        if (linkStyle === "published" && linkHref) {
          const to = node ? linkHref(node, blockId, heading) : null;
          // data-note: which note the link opens — what the site's link preview keys on.
          return to && node ? <Link className="published-inline-link" href={to} data-note={node.id}>{ch}</Link> : <span className="published-inline-link">{ch}</span>;
        }
        if (linkStyle === "published") {
          return (
            <Pressable
              className="published-inline-link"
              onClick={() => onNavigate(slugOnly, node?.id ?? null, blockId, heading)}
              disabled={!!nodes && !node}
            >
              {ch}
            </Pressable>
          );
        }
        const open = () => {
          // A guess (`lost` with a best guess) is not followed: the link opens the note, the person decides about the guess.
          if (tail.at !== null && node && !tail.lost) setPendingCursor(node.id, tail.at, tail.at);
          onNavigate(slugOnly, node?.id ?? task?.id ?? null, blockId, heading);
        };
        return (
          <>
            <Pressable className={classNames("wikilink-token", known && "known")} onClick={open}>
              {ch}
            </Pressable>
            {(tail.maybe || tail.lost) && node && (
              <Suspense fallback={null}>
                <PartLinkNote noteId={node.id} anchorId={(tail.maybe ?? tail.lost)!} lost={!tail.maybe} guessed={tail.at !== null} />
              </Suspense>
            )}
          </>
        );
      }
      // Bare YouTube/Vimeo link on its own — render as an inline embed instead
      // of a plain link. Only when the link TEXT equals the URL (autolink /
      // pasted bare URL), so explicit `[label](url)` links stay links.
      const embedUrl = toEmbedUrl(href);
      const childText = typeof ch === "string" ? ch : Array.isArray(ch) ? ch.join("") : "";
      if (embedUrl && (childText === href || childText === "")) {
        return <EmbedIframe src={embedUrl} title={childText || undefined} />;
      }
      // In-page fragments (footnotes and their back-links) stay in the page,
      // keeping their id so the back-link has a target.
      if ((href ?? "").startsWith("#")) return <Link href={href} id={id}>{ch}</Link>;
      return <Link href={href} target="_blank" rel="noreferrer">{ch}</Link>;
    },
    // Raw-HTML <iframe> (e.g. pasted YouTube embed code). Survives sanitize as
    // an allowed tag, but its host is gated HERE — only trusted providers are
    // framed; anything else is dropped. Always sandboxed.
    iframe: ({ src, title }) => {
      const embed = toEmbedUrl(src ?? "") ?? (isAllowedEmbedSrc(src) ? (src as string) : null);
      if (!embed) return null;
      return <EmbedIframe src={embed} title={title as string | undefined} />;
    },
    // Raw-HTML <video>/<audio>. Sanitized to safe attrs; rendered with controls.
    video: MdVideo,
    audio: MdAudio,
    input: ({ checked }) => {
      // Each task checkbox claims the next document-order index. The counter is
      // reset at the top of every render (see checkboxIndex above).
      const myIndex = checkboxIndex.current;
      checkboxIndex.current += 1;
      const cls = classNames("md-checkbox", checked && "checked");
      // Read-only surfaces (published site, previews without a save path) keep
      // the original inert presentation. With a toggle handler the checkbox is
      // a real keyboard-focusable control that flips the source line.
      if (!onToggleTask) {
        return <span className={cls} role="checkbox" aria-checked={!!checked} aria-readonly="true" />;
      }
      return (
        <Pressable
          type="button"
          role="checkbox"
          aria-checked={!!checked}
          // nodrag: on a board card (React Flow) a press here toggles, it
          // does not start dragging the card.
          className={classNames(cls, "md-checkbox--interactive", "nodrag")}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTask(myIndex); }}
        />
      );
    },
    // Wrap rendered fenced-code blocks with a small copy-to-clipboard button.
    // The `code` override below still handles onden-query / onden-base / mermaid
    // (those return their own elements, not a <pre>, so they bypass this).
    pre: ({ children, ...rest }) => (diagramFor?.(mermaidBlockSource(rest.node) ?? "\0")) ? <>{children}</> : isStatic && !(stepsOn && preLang(children) === STEPS_LANG) ? <pre {...rest}>{children}</pre> : <CodeBlock {...rest} mermaidOn={enableMermaid} published={profile === "published"} stepsOn={stepsOn}>{children}</CodeBlock>,
    // Always-on code-block branch: detects `onden-query` blocks regardless
    // of the mermaid flag, and falls through to mermaid handling when the
    // flag is on. Pure `<code>` rendering for everything else.
    code: ({ className: cls, children: ch, ...rest }) => {
      const lang = /language-([\w-]+)/.exec(cls ?? "")?.[1] ?? "";
      const isBlock = !("inline" in rest) || !(rest as Record<string, unknown>).inline;
      // Readers of the site (and its exports) see the result frozen at
      // publish time, listing published notes only — never a live query,
      // which would call the authenticated /api/* (D113).
      if (profile === "published" && isQueryBlockLang(lang) && isBlock) {
        return (
          <FrozenQueryResult
            block={frozenQueryBlock(queryBlocks, lang, String(ch))}
            nodes={nodes}
            onNavigate={onNavigate}
            linkHref={linkHref}
          />
        );
      }
      if (lang === "onden-query" && isBlock) {
        return (
          <Suspense fallback={null}>
            <OndenQueryBlock
              source={String(ch).replace(/\n$/, "")}
              onSelectNode={(slug) => onNavigate?.(slug, nodes?.find(n => n.slug === slug)?.id ?? null)}
            />
          </Suspense>
        );
      }
      if (lang === "onden-base" && isBlock) {
        // MarkdownRenderer's nodes prop is the minimal LinkNode shape
        // (id/title/slug) for navigation. The base eval needs the full
        // ContentNode (markdown/attrs/class_tag_ids), which the app's
        // surfaces pass. (The published profile never gets here: it draws
        // the frozen result above.)
        return (
          <Suspense fallback={null}>
            <OndenBaseBlock
              source={String(ch).replace(/\n$/, "")}
              nodes={(nodes ?? []) as unknown as ComponentProps<typeof OndenBaseBlock>["nodes"]}
              onSelectNode={(id) => {
                const n = nodes?.find(nn => nn.id === id);
                if (n) onNavigate?.(n.slug, id);
              }}
            />
          </Suspense>
        );
      }
      if (lang === "mermaid" && isBlock && diagramFor) {
        const drawn = diagramFor(String(ch).replace(/\n$/, ""));
        if (drawn) return <>{drawn}</>;
      }
      if (stepsOn && lang === STEPS_LANG && isBlock) {
        const View = stepsView ?? StepsFigure;
        return (
          <Suspense fallback={<div className="md-steps" />}>
            <View source={String(ch).replace(/\n$/, "")} renderBody={renderStepBody} labels={figureLabels} />
          </Suspense>
        );
      }
      if (enableMermaid && lang === "mermaid" && isBlock) {
        return <MermaidBlock code={String(ch).replace(/\n$/, "")} />;
      }
      return <code className={cls}>{ch}</code>;
    },
    // `![alt](url)`: stable type, props via ImageEnvContext (see MdVideo).
    img: MdImage,
  }), [onNavigate, nodes, tasks, t, enableMermaid, diagramFor, linkStyle, linkHref, onToggleTask, profile, queryBlocks, isStatic, stepsOn, stepsView, renderStepBody, figureLabels, partLinks]);

  const renderWith = (enhancers: MarkdownEnhancers) => {
    const pipeline = ondenMarkdownCore(options, enhancers);
    return (
      <ReactMarkdown
        remarkPlugins={pipeline.remarkPlugins}
        remarkRehypeOptions={pipeline.remarkRehypeOptions}
        rehypePlugins={profile === "published" ? [...pipeline.rehypePlugins, rehypeMediaSvgLinks] : pipeline.rehypePlugins}
        components={components}
        // defaultUrlTransform strips ALL data: URLs; inline media (data:image/
        // audio/video on src — how published Onden sites and their feeds embed
        // sounds/pictures) must survive. Scoped to `src`: a data: HREF stays
        // stripped, and the sanitize schema + iframe host gate bound the rest.
        urlTransform={(url, key) =>
          key === "src" && SAFE_DATA_MEDIA_SRC.test(url) ? url : defaultUrlTransform(url)
        }
      >
        {pipeline.prepare(children)}
      </ReactMarkdown>
    );
  };
  const imageEnv = useMemo<ImageEnv>(
    () => ({ from: { id: fromId, space_id: fromSpace }, nodes, onNavigate, resolveImage, handwritingAlt }),
    [fromId, fromSpace, nodes, onNavigate, resolveImage, handwritingAlt],
  );
  return (
    <ImageEnvContext.Provider value={imageEnv}>
      {!suspense ? renderWith(loaded.enhancers) : (
        <Suspense fallback={renderWith(loaded.enhancers)}>
          <WhenLoaded needs={needs} loaded={loaded} onMissing={onMissing} render={renderWith} />
        </Suspense>
      )}
    </ImageEnvContext.Provider>
  );
}

function decodeHeading(encoded: string): string {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}
