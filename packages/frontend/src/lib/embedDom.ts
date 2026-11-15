// Drawing an embed (lib/embeds.ts resolveEmbed) into a DOM element: one
// renderer per kind, shared by the preview (MarkdownRenderer's EmbedBlock)
// and the editor's block widget (lib/editorEmbeds.ts), so both show the same.
//
// Block, section and note embeds show part of the source note's Markdown
// (lib/embeds embedExcerpt), drawn read-only by the normal MarkdownRenderer in
// its own React root; "— Note title" under it opens the source.
//
// Lazy: nothing is read or drawn until the element is near the viewport
// (IntersectionObserver), so a note with many drawings opens and types at
// full speed; the SVG itself is cached per drawing version (drawingSvg).

import { createElement } from "react";
import type { Root } from "react-dom/client";
import { blockHome } from "./blockHome";
import { embedExcerpt, type EmbedExcerpt, type ResolvedEmbed } from "./embeds";
import { drawingRegion, drawingSvg, embedSource } from "./embedSources";
import { onDrawingChange } from "./drawingChanges";
import { requestInkRegionFocus } from "./inkRegionFocus";
import type { InkRegion, InkRegionPicture } from "@onden/markdown/ink";
import { taskChips } from "./taskChips";
import type { WikilinkNode, WikilinkSource } from "./wikilinks";
import { t } from "./i18n";
import { fadeOutDetached } from "./mediaFadeOut";
import { displayTitle } from "./noteLabel";
import "../styles/embeds.css";

export type EmbedHost = {
  /** Open the embedded note (its id; the block id for a block embed). */
  onOpen?: (nodeId: string, blockId?: string) => void;
  /** The notes and the note the embed is written in: the embedded text's own
   *  [[links]] resolve against them. */
  nodes?: readonly WikilinkNode[];
  from?: WikilinkSource | null;
  /** The editor's host (lib/editorEmbeds) sets this: a tap on a block / section
   *  / note embed's text edits the source there, and a tap on a drawing opens
   *  it, so a tap never turns the embed back into `![[…]]` text. Absent in the
   *  preview, which is read-only. */
  onEdit?: (embed: EditableEmbed) => void;
  /** The editor's host sets this: may the reader change `node`? Then a block embed whose paragraph
   *  was deleted offers 「救回」. Absent in the read-only preview, which only says it was deleted. */
  canRestoreBlock?: (node: WikilinkNode) => boolean;
  /** Tick or untick an embedded task (lib/embedTasks). Absent: the box is shown but cannot be changed. */
  setTaskDone?: (taskId: string, done: boolean) => void;
};

type Shown = Exclude<ResolvedEmbed, { kind: "missing" | "task" }>;
/** An embed shown from a note's text (block, section or whole note; a drawing
 *  is never passed to `onEdit`). */
export type EditableEmbed = Exclude<Shown, { kind: "part" }>;

/** Controls inside an embed that act on their own when tapped. */
const OWN_ACTION = "a, button, input, summary, [role=button]";

/** Start rendering at most this far below the fold. */
const LOOKAHEAD = "400px";

function openButton(text: string, className: string, onClick: (() => void) | undefined): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  if (onClick) button.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
  else button.disabled = true;
  return button;
}

/** A link to the embedded note (block): the fallback when it cannot be shown. */
function renderLink(el: HTMLElement, embed: Shown, host: EmbedHost) {
  el.replaceChildren(openButton(`↗ ${embed.ref.label ?? embed.node.title ?? embed.label}`, "md-embed-link",
    host.onOpen && (() => host.onOpen!(embed.node.id, embed.kind === "block" ? embed.blockId : undefined))));
  el.dataset.embedState = "link";
}

/** Open the drawing a picture shows; a quoted region also asks the handwriting view to scroll to it. */
function openDrawing(embed: Shown, host: EmbedHost, region: InkRegion | null) {
  if (region) requestInkRegionFocus(embed.node.id, region);
  host.onOpen?.(embed.node.id);
}

/** A whole drawing, or with `region` the part of one page of it that was quoted: the same figure,
 *  colours and open button; only the picture and its width differ. */
function renderDrawing(el: HTMLElement, svg: string | null, embed: Shown, host: EmbedHost, region: InkRegion | null = null) {
  const figure = document.createElement("figure");
  figure.className = "md-drawing";
  const picture = document.createElement("div");
  picture.className = "md-drawing-picture";
  picture.setAttribute("role", "img");
  picture.setAttribute("aria-label", embed.label);
  if (region) {
    // As wide as that part of the page is of the content column, never wider than it, and not a speck.
    picture.classList.add("md-drawing-picture--region");
    picture.style.setProperty("--region-w", String(Math.round(region.w)));
  }
  // inkToSvg's output: numbers and sanitised colours only (no note text).
  if (svg) picture.innerHTML = svg;
  else {
    picture.classList.add("md-drawing-empty");
    picture.textContent = t("This drawing is empty.");
  }
  const caption = document.createElement("figcaption");
  caption.append(openButton(t("Open drawing"), "md-drawing-open", host.onOpen && (() => openDrawing(embed, host, region))));
  figure.append(picture, caption);
  if (host.onEdit && host.onOpen) {
    picture.classList.add("md-drawing-tappable");
    picture.addEventListener("click", () => openDrawing(embed, host, region));
  }
  el.replaceChildren(figure);
  el.dataset.embedState = "drawing";
}

/** What stands where the text cannot be shown. Never the source note's title:
 *  a reader who may not read the note learns nothing about it. */
function unreadableText(embed: Shown, reason: "forbidden" | "notFound"): string {
  if (reason === "forbidden") return t("Content you cannot access");
  return embed.kind === "block" ? t("This block was not found") : t("Not found");
}

/** Why a quoted region shows no picture: said in words, never an empty frame. */
function regionNotice(picture: Exclude<InkRegionPicture, { kind: "picture" }>): string {
  if (picture.kind === "notInk") return t("This note has no handwriting");
  return picture.kind === "page" ? t("This handwriting page was deleted") : t("Nothing is written in this area now");
}

/** A quiet line where the embedded text would be: never an error. */
function renderNotice(el: HTMLElement, text: string, state: string) {
  const line = document.createElement("div");
  line.className = "md-embed-notice";
  line.textContent = text;
  el.replaceChildren(line);
  el.dataset.embedState = state;
}

/** `![[Note#^id]]` whose paragraph is gone from its note and from every other note the reader
 *  sees: 「這段已刪除」, plus 「救回」 when the note's history still has it and the reader may edit
 *  the note. `current` is the note's text now. `isLive` goes false when the embed is redrawn. */
function renderDeletedBlock(el: HTMLElement, embed: Extract<Shown, { kind: "block" }>, host: EmbedHost, current: string, isLive: () => boolean) {
  renderNotice(el, t("This paragraph was deleted"), "deleted");
  if (!host.canRestoreBlock?.(embed.node)) return;
  void import("./blockSafety").then(async ({ findDeletedBlock, restoreDeletedBlock }) => {
    const block = await findDeletedBlock(embed.node.id, embed.blockId, current);
    if (!block || !isLive()) return;
    const line = el.querySelector(".md-embed-notice");
    if (!line) return;
    line.textContent = `${t("This paragraph was deleted")} · `;
    const restore = openButton(t("Restore"), "md-embed-restore", () => {
      restore.disabled = true;
      void restoreDeletedBlock(embed.node.id, block).then((ok) => { if (!ok) restore.disabled = false; });
    });
    line.append(restore);
    el.dataset.embedState = "deleted-restorable";
  });
}

/** The embedded text in a read-only MarkdownRenderer, a "Show more" toggle
 *  for a long note, and the "— Note title" line that opens the source. The
 *  renderer is loaded on first use (it imports this module). Returns the
 *  cleanup that unmounts it. */
function renderExcerpt(el: HTMLElement, excerpt: EmbedExcerpt, embed: Shown, host: EmbedHost): () => void {
  const box = document.createElement("div");
  box.className = "md-transclusion";
  const body = document.createElement("div");
  body.className = "md-transclusion-body";
  const footer = document.createElement("div");
  footer.className = "md-transclusion-footer";
  const blockId = embed.kind === "block" ? embed.blockId : undefined;
  const open = host.onOpen && (() => host.onOpen!(embed.node.id, blockId));
  const source = openButton(`— ${embed.node.title || embed.label}`, "md-embed-source", open);
  footer.append(source);
  box.append(body, footer);
  if (host.onEdit && embed.kind !== "drawing" && embed.kind !== "part") {
    box.classList.add("md-transclusion--editable");
    box.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest(OWN_ACTION)) return;
      host.onEdit!(embed);
    });
  }
  el.replaceChildren(box);
  el.dataset.embedState = embed.kind === "block" ? "block" : embed.kind === "part" ? "part" : embed.heading ? "section" : "note";

  const text = mountNoteText(body, { nodes: host.nodes, from: { id: embed.node.id, space_id: host.from?.space_id }, onOpen: host.onOpen });
  let expanded = false;
  const draw = () => text.render(expanded ? excerpt.full : excerpt.text);
  if (excerpt.more) {
    const toggle = openButton(t("Show more"), "md-embed-more", () => {
      expanded = !expanded;
      toggle.textContent = expanded ? t("Show less") : t("Show more");
      draw();
    });
    footer.prepend(toggle);
  }
  draw();
  return text.unmount;
}

/** Markdown drawn read-only in `body` by the normal MarkdownRenderer (loaded on first use, in its own React root):
 *  an embed's excerpt, and a table the editor draws in place (lib/editorTables). `render` may be called again with
 *  new text; `unmount` ends it (not inside a React or CodeMirror update, so on the next tick). */
export function mountNoteText(
  body: HTMLElement,
  host: { nodes?: readonly WikilinkNode[]; from?: WikilinkSource | null; onOpen?: (nodeId: string, blockId?: string) => void },
): { render: (markdown: string) => void; unmount: () => void } {
  let root: Root | null = null;
  let live = true;
  let latest = "";
  const draw = async () => {
    const [{ createRoot }, { NotePreview }] = await Promise.all([import("react-dom/client"), import("../components/markdownSurfaces")]);
    if (!live) return;
    root ??= createRoot(body);
    const onNavigate = host.onOpen && ((_slug: string, nodeId: string | null, block?: string) => { if (nodeId) host.onOpen!(nodeId, block); });
    // eslint-disable-next-line react/no-children-prop -- required prop; createElement from a .ts file
    root.render(createElement(NotePreview, { nodes: host.nodes as never, from: host.from, onNavigate, children: latest }));
  };
  return {
    render: (markdown) => { latest = markdown; void draw(); },
    unmount: () => {
      live = false;
      // The widget DOM may leave the document before the unmount below runs.
      body.querySelectorAll("audio,video").forEach((m) => fadeOutDetached(m as HTMLMediaElement));
      const mounted = root;
      root = null;
      if (mounted) queueMicrotask(() => mounted.unmount());
    },
  };
}

/** A task as a live row: checkbox, title, chips. The box completes (or
 *  reopens) the task through the task writer — the task page and the note line
 *  it came from follow, as when it is ticked there. Where this reader may not
 *  write, the box shows the state and does nothing. A task the reader holds no
 *  copy of reads as unreadable, never by its title. */
function renderTask(el: HTMLElement, embed: Extract<ResolvedEmbed, { kind: "task" }>, host: EmbedHost) {
  const ref = embed.task;
  if (!ref) return renderNotice(el, t("Content you cannot access"), "forbidden");
  const { task } = ref;
  const row = document.createElement("div");
  row.className = "md-task-embed";
  row.classList.toggle("is-done", task.done);
  const box = document.createElement("button");
  box.type = "button";
  box.className = "md-task-box";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", String(task.done));
  box.setAttribute("aria-label", displayTitle(ref.title));
  if (task.writable && host.setTaskDone) {
    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const done = box.getAttribute("aria-checked") !== "true";
      box.setAttribute("aria-checked", String(done));
      row.classList.toggle("is-done", done);
      host.setTaskDone!(ref.id, done);
    });
  } else {
    box.setAttribute("aria-disabled", "true");
    box.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  }
  const title = openButton(displayTitle(ref.title), "md-task-title", host.onOpen && (() => host.onOpen!(ref.id)));
  row.append(box, title);
  for (const text of taskChips(task)) {
    const chip = document.createElement("span");
    chip.className = "md-task-chip";
    chip.textContent = text;
    row.append(chip);
  }
  el.replaceChildren(row);
  el.dataset.embedState = "task";
}

/** Render `embed` into `el` once it nears the viewport. Returns a cleanup
 *  that stops a pending render (call it when the element goes away). */
export function mountEmbed(el: HTMLElement, embed: ResolvedEmbed, host: EmbedHost): () => void {
  el.classList.add("md-embed-block");
  if (embed.kind === "missing") {
    // A quoted region is never shown as its syntax: the note it names is gone, or not readable.
    if (embed.ref.inkRegion) renderNotice(el, t("Not found"), "missing");
    else {
      el.textContent = `![[${embed.ref.body}]]`;
      el.dataset.embedState = "missing";
    }
    return () => {};
  }
  // A task is read from the rows the app holds: nothing to load or wait for.
  if (embed.kind === "task") {
    renderTask(el, embed, host);
    return () => {};
  }
  let live = true;
  let unmount: (() => void) | null = null;
  el.dataset.embedState = "loading";
  const placeholder = document.createElement("div");
  placeholder.className = "md-drawing-loading";
  placeholder.textContent = embed.kind === "block" || embed.kind === "part" ? t("Loading…") : t("Loading drawing…");
  el.replaceChildren(placeholder);
  // Block, section and note: the source's text, or a quiet notice.
  const transclude = () => {
    embedSource(embed.node).then((source) => {
      if (!live) return;
      if (!source.ok) {
        if (source.reason === "unavailable") renderLink(el, embed, host);
        else renderNotice(el, unreadableText(embed, source.reason), source.reason);
        return;
      }
      const excerpt = embedExcerpt(embed, source.markdown);
      if (excerpt) unmount = renderExcerpt(el, excerpt, embed, host);
      else if (embed.kind === "block") fromHome(embed, source.markdown);
      else if (embed.kind === "part") renderNotice(el, t("This paragraph was deleted"), "deleted");
      else renderNotice(el, unreadableText(embed, "notFound"), "notFound");
    }, () => { if (live) renderLink(el, embed, host); });
  };
  // `![[A#^id]]` where A lost the block: the note that holds it (lib/blockHome).
  // Shown as that note — the "— Note" line names and opens where the text
  // really is — and the written link is left as it is.
  const fromHome = (block: Extract<Shown, { kind: "block" }>, current: string) => {
    const notFound = () => renderDeletedBlock(el, block, host, current, () => live);
    void blockHome(block.node, block.blockId, host.nodes).then(async (home) => {
      if (!live) return;
      if (!home) return notFound();
      const source = await embedSource(home);
      if (!live) return;
      const moved = { ...block, node: home };
      const excerpt = source.ok ? embedExcerpt(moved, source.markdown) : null;
      if (excerpt) unmount = renderExcerpt(el, excerpt, moved, host);
      else notFound();
    });
  };
  // `![[drawing|ink=頁@x,y,w,h]]`: one region of one page, redrawn when the drawing is saved here.
  const region = embed.kind === "drawing" || (embed.kind === "note" && !embed.heading) ? embed.ref.inkRegion : null;
  const drawRegion = (quoted: InkRegion) => {
    drawingRegion(embed.node.id, quoted).then((picture) => {
      if (!live) return;
      if (picture.kind === "picture") renderDrawing(el, picture.svg, embed, host, quoted);
      else renderNotice(el, regionNotice(picture), picture.kind);
    }, () => { if (live) renderLink(el, embed, host); });
  };
  const draw = () => {
    if (region) {
      drawRegion(region);
      const stop = onDrawingChange(embed.node.id, () => { if (live) drawRegion(region); });
      const before = unmount;
      unmount = () => { stop(); before?.(); };
      return;
    }
    // Only a whole-note embed may be a drawing; a block or section never is.
    if (embed.kind === "block" || embed.kind === "part" || (embed.kind === "note" && embed.heading)) return transclude();
    drawingSvg(embed.node.id).then((svg) => {
      if (!live) return;
      if (svg !== null || embed.kind === "drawing") renderDrawing(el, svg, embed, host);
      else transclude();
    }, () => { if (live) renderLink(el, embed, host); });
  };
  if (typeof IntersectionObserver === "undefined") {
    const timer = setTimeout(draw, 0);
    return () => { live = false; clearTimeout(timer); unmount?.(); };
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    draw();
  }, { rootMargin: LOOKAHEAD });
  observer.observe(el);
  return () => { live = false; observer.disconnect(); unmount?.(); };
}
