// Draws the note graph on a published page: the small graph of the current page, and the
// whole site's graph over the page. Loaded only when a graph scrolls into view
// (SiteNavigation.astro), so a page that never shows one does not carry this code. Each note is an
// SVG link, so keyboard and "open in new tab" work as on any link.
import { layoutGraph, neighbourhood, shortLabel, type SiteGraph } from "./siteGraph";

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

let loading: Promise<SiteGraph> | null = null;
/** `/site/graph.json`, next to the site's search index (so it resolves in a copy under a subpath too). */
function loadGraph(): Promise<SiteGraph> {
  const folder = document.querySelector<HTMLLinkElement>('link[rel="x-site-search"]')?.href;
  const url = folder ? new URL("../graph.json", folder).href : "/site/graph.json";
  loading ??= fetch(url).then((res) => {
    if (!res.ok) throw new Error("graph unavailable");
    return res.json() as Promise<SiteGraph>;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

/** A page of the site is `<site>/<slug>/`, so a sibling note is `../<slug>/`. */
const hrefOf = (slug: string): string => `../${encodeURIComponent(slug)}/`;

type Options = { width: number; height: number; centreId: string | null; labelMax: number; label: string; fontSize: number };

function draw(graph: SiteGraph, o: Options): SVGSVGElement {
  const points = layoutGraph(graph.notes.length, graph.links, o.width, o.height);
  const degree = graph.notes.map(() => 0);
  for (const [a, b] of graph.links) { degree[a]!++; degree[b]!++; }
  const svg = el("svg", { viewBox: `0 0 ${o.width} ${o.height}`, class: "s-graph__svg", role: "group", "aria-label": o.label });
  const lines = el("g", { class: "s-graph__links" });
  for (const [a, b] of graph.links) {
    lines.append(el("line", { x1: points[a]!.x, y1: points[a]!.y, x2: points[b]!.x, y2: points[b]!.y }));
  }
  svg.append(lines);
  graph.notes.forEach((note, i) => {
    const here = note.id === o.centreId;
    const r = here ? 9 : 5 + Math.min(4, degree[i]!);
    const group = here ? el("g", { class: "s-graph__node s-graph__node--here", "aria-current": "page" }) : el("a", { class: "s-graph__node", href: hrefOf(note.slug) });
    const title = el("title");
    title.textContent = note.title;
    group.append(title, el("circle", { cx: points[i]!.x, cy: points[i]!.y, r }));
    const text = el("text", { x: points[i]!.x, y: points[i]!.y + r + 12, "text-anchor": "middle", "font-size": o.fontSize });
    text.textContent = shortLabel(note.title, o.labelMax);
    group.append(text);
    svg.append(group);
  });
  return svg;
}

/** The small graph of one page, inside `canvas`. */
export async function mountLocalGraph(canvas: HTMLElement, centreId: string): Promise<void> {
  try {
    const local = neighbourhood(await loadGraph(), centreId);
    if (!local || local.notes.length < 2) { canvas.hidden = true; return; }
    canvas.replaceChildren(draw(local, { width: 320, height: 240, centreId, labelMax: 8, fontSize: 11, label: canvas.dataset.title ?? "" }));
  } catch {
    canvas.hidden = true;
  }
}

/** The whole site's graph over the page, in a modal `<dialog>` (the browser gives it Esc, a Tab that stays inside,
 *  an inert page behind and the focus back on the button): pan with a drag, zoom with the wheel or two fingers. */
export async function openFullGraph(centreId: string | null, text: { title: string; close: string; failed: string }): Promise<void> {
  const layer = document.createElement("dialog");
  layer.className = "s-graph-full";
  layer.setAttribute("aria-label", text.title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "s-graph-full__close";
  close.textContent = text.close;
  close.addEventListener("click", () => layer.close());
  const body = document.createElement("div");
  body.className = "s-graph-full__body";
  layer.append(close, body);
  layer.addEventListener("close", () => layer.remove());
  document.body.append(layer);
  // The published site is plain HTML with small scripts (no React in the browser), so ui/Modal cannot be used here;
  // the native modal dialog gives the same Esc, focus and inert page.
  // eslint-disable-next-line onden/modals-through-ui-modal
  layer.showModal();

  let graph: SiteGraph;
  try { graph = await loadGraph(); } catch {
    body.textContent = text.failed;
    return;
  }
  const count = graph.notes.length;
  const side = Math.max(600, Math.round(Math.sqrt(count) * 90));
  const svg = draw(graph, { width: side, height: Math.round(side * 0.75), centreId, labelMax: 14, fontSize: 12, label: text.title });
  svg.classList.add("s-graph__svg--full");
  body.append(svg);
  enablePanZoom(svg);
}

function enablePanZoom(svg: SVGSVGElement): void {
  const base = svg.viewBox.baseVal;
  let view = { x: base.x, y: base.y, w: base.width, h: base.height };
  const apply = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const rect = svg.getBoundingClientRect();
    const px = view.x + ((clientX - rect.left) / rect.width) * view.w;
    const py = view.y + ((clientY - rect.top) / rect.height) * view.h;
    const w = Math.min(base.width * 4, Math.max(base.width / 8, view.w * factor));
    const k = w / view.w;
    view = { x: px - (px - view.x) * k, y: py - (py - view.y) * k, w, h: view.h * k };
    apply();
  };
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  svg.addEventListener("pointerdown", (e) => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = 0; });
  const release = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch = 0; };
  svg.addEventListener("pointerup", release);
  svg.addEventListener("pointercancel", release);
  svg.addEventListener("pointermove", (e) => {
    const was = pointers.get(e.pointerId);
    if (!was) return;
    const rect = svg.getBoundingClientRect();
    if (pointers.size === 1) {
      view = { ...view, x: view.x - ((e.clientX - was.x) / rect.width) * view.w, y: view.y - ((e.clientY - was.y) / rect.height) * view.h };
      apply();
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const gap = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0) zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, pinch / gap);
      pinch = gap;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
}
