// The ```steps player and its code transition as plain DOM code: no framework,
// fetched on demand. The published site wires it over the server-drawn markup
// (`installStepsPlayers`: without script the steps are a plain list), and the
// app's React player draws the same markup and borrows `flipCode`.
// Which line is which lives in lineAlign.ts; the keys and the swipe in
// stepsNav.ts. Docs: docs/architecture/steps-block.md.
//
// Markup contract (stepsMarkup in the app's StepsView; the site's too):
//   .md-steps[data-steps][data-l-*]  one figure; the data-l-* are its words
//     .md-steps-intro                 optional note on the whole figure
//     .md-steps-stage
//       section.md-step[data-step-title]   one step; its body is Markdown HTML
// The player adds `.is-player` on the figure, a bar before the stage, and
// `.is-active` on the shown step; `.is-expanded` shows every step in a column.

import { alignLines } from "./lineAlign.js";
import { stepForKey, swipeStep } from "./stepsNav.js";

export const STEPS_CLASS = "md-steps";

const reducedMotion = (doc: Document): boolean =>
  doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** `code`'s content cut into one element per line, each keeping the syntax
 *  colour spans that were open at the line break (a comment over many lines
 *  stays a comment on each). The input is not changed. */
export function splitCodeLines(code: Element): HTMLElement[] {
  const doc = code.ownerDocument;
  const endsWithNewline = (code.textContent ?? "").endsWith("\n");
  const lines: HTMLElement[] = [];
  // the open elements of the current line, outermost first (the line itself is [0])
  let open: Element[] = [];
  const startLine = (stack: readonly Element[]): void => {
    const line = doc.createElement("span");
    line.className = "md-line";
    lines.push(line);
    open = [line];
    for (const el of stack) {
      const copy = el.cloneNode(false) as Element;
      open[open.length - 1]!.append(copy);
      open.push(copy);
    }
  };
  const walk = (node: Node, stack: readonly Element[]): void => {
    if (node.nodeType === 3) {
      const parts = (node.nodeValue ?? "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) startLine(stack);
        if (part) open[open.length - 1]!.append(doc.createTextNode(part));
      });
    } else if (node.nodeType === 1) {
      const el = node as Element;
      const copy = el.cloneNode(false) as Element;
      open[open.length - 1]!.append(copy);
      open.push(copy);
      const inner = [...stack, el];
      for (const child of el.childNodes) walk(child, inner);
      open.pop(); // after a line break inside, startLine rebuilt the chain with this element last
    }
  };
  startLine([]);
  for (const child of code.childNodes) walk(child, []);
  if (endsWithNewline) lines.pop(); // a code block's text ends with a newline: no extra line
  return lines;
}

export type CodeFlip = { /** End the transition now (a newer step was chosen). */ finish(): void };

const FLIP_MS = 420;
const ADDED_MS = 1400;

/** The code of step `to` appears as the code of step `from` changes into it:
 *  unchanged lines slide from their old place to the new, new lines fade in
 *  and are marked for a moment, removed lines fade out (the FLIP technique:
 *  measure the first and last place, play the difference as a transform).
 *  Both codes must be laid out (the player keeps every step in the stage, the
 *  hidden ones only `visibility: hidden`). The transition is drawn by an
 *  overlay copy of `to`, so the step's own nodes are not changed (the app's
 *  React tree stays whole); `to` is hidden while it plays. */
export function flipCode(from: Element, to: Element, ms: number = FLIP_MS): CodeFlip {
  const noop: CodeFlip = { finish() {} };
  const host = to.parentElement;
  if (!host || typeof host.animate !== "function") return noop;
  const before = splitCodeLines(from);
  const after = splitCodeLines(to);
  const { from: source, removed } = alignLines(before.map((l) => l.textContent ?? ""), after.map((l) => l.textContent ?? ""));
  if (after.length === 0 && before.length === 0) return noop;

  const fromRect = from.getBoundingClientRect();
  const toRect = to.getBoundingClientRect();
  const fromHeight = fromRect.height / Math.max(before.length, 1);
  const toHeight = toRect.height / Math.max(after.length, 1);

  const overlay = to.cloneNode(false) as HTMLElement;
  overlay.classList.add("md-flip");
  overlay.setAttribute("aria-hidden", "true");
  const hostRect = host.getBoundingClientRect();
  Object.assign(overlay.style, {
    position: "absolute", display: "block",
    top: `${toRect.top - hostRect.top + host.scrollTop}px`, left: `${toRect.left - hostRect.left + host.scrollLeft}px`,
    width: `${toRect.width}px`, height: `${toRect.height}px`,
  });
  const animations: Animation[] = [];
  const timers: number[] = [];
  const duration = Math.max(0, ms);
  after.forEach((line, i) => {
    line.classList.add("md-flip-line");
    overlay.append(line);
    const old = source[i];
    if (old === null || old === undefined) {
      line.classList.add("md-line-added");
      animations.push(line.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: "ease-out", fill: "backwards" }));
      timers.push(window.setTimeout(() => line.classList.remove("md-line-added"), ADDED_MS));
    } else {
      const dy = fromRect.top + old * fromHeight - (toRect.top + i * toHeight);
      if (Math.abs(dy) >= 0.5) animations.push(line.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration, easing: "cubic-bezier(.2,.7,.2,1)" }));
    }
  });
  for (const i of removed) {
    const ghost = before[i]!;
    ghost.classList.add("md-flip-line", "md-line-removed");
    Object.assign(ghost.style, { position: "absolute", left: "0", right: "0", top: `${fromRect.top + i * fromHeight - toRect.top}px` });
    overlay.append(ghost);
    animations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.6, easing: "ease-in", fill: "forwards" }));
  }

  const code = to as HTMLElement;
  const was = code.style.visibility;
  code.style.visibility = "hidden";
  host.append(overlay);
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    for (const a of animations) a.cancel();
    for (const t of timers) window.clearTimeout(t);
    overlay.remove();
    code.style.visibility = was;
  };
  void Promise.all(animations.map((a) => a.finished.catch(() => {}))).then(finish);
  if (animations.length === 0) finish();
  return { finish };
}

/** The `to` step's code paired with each code of the `from` step: the nth code
 *  block of one with the nth of the other, when both are the same language.
 *  Other content is left to the step's fade. */
export function pairedCodes(from: Element, to: Element): Array<[Element, Element]> {
  const codes = (step: Element): Element[] => [...step.querySelectorAll("pre > code")];
  const langOf = (code: Element): string => /language-([\w-]+)/.exec(code.className)?.[1] ?? "";
  const a = codes(from);
  const b = codes(to);
  const out: Array<[Element, Element]> = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (langOf(a[i]!) === langOf(b[i]!)) out.push([a[i]!, b[i]!]);
  return out;
}

/** Changes `from` into `to` (two `.md-step` elements of one figure): the paired
 *  code blocks flip, unless the reader prefers reduced motion. */
export function playStepChange(from: Element, to: Element, reduced: boolean): CodeFlip {
  if (reduced) return { finish() {} };
  const flips = pairedCodes(from, to).map(([a, b]) => flipCode(a, b));
  return { finish: () => flips.forEach((f) => f.finish()) };
}

const word = (root: HTMLElement, key: string, fallback: string): string => root.getAttribute(`data-l-${key}`) ?? fallback;

function barButton(doc: Document, label: string, glyph: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "md-steps-btn";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.textContent = glyph;
  return b;
}

/** Whether `el` is in a block (a code block) that can be scrolled sideways. */
function scrollsSideways(el: Element): boolean {
  for (let node: Element | null = el; node && !node.classList.contains("md-steps-stage"); node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth && ["auto", "scroll"].includes(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** Turns one server-drawn figure into a player. Returns a function that undoes it. */
export function installStepsPlayer(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const steps = [...root.querySelectorAll<HTMLElement>(".md-steps-stage > .md-step")];
  if (steps.length === 0 || root.classList.contains("is-player")) return () => {};
  const total = steps.length;
  let index = 0;
  let expanded = false;
  let flip: CodeFlip | null = null;

  const prev = barButton(doc, word(root, "prev", "Previous step"), "◀");
  const next = barButton(doc, word(root, "next", "Next step"), "▶");
  const all = doc.createElement("button");
  all.type = "button";
  all.className = "md-steps-all";
  all.setAttribute("aria-pressed", "false");
  const status = doc.createElement("span");
  status.className = "md-steps-status";
  status.setAttribute("aria-live", "polite");
  const bar = doc.createElement("div");
  bar.className = "md-steps-bar";
  bar.append(prev, status, next, all);
  root.querySelector(".md-steps-stage")!.before(bar);
  root.classList.add("is-player");
  root.tabIndex = 0;

  const statusText = (): string => {
    const count = word(root, "count", "Step {n} of {m}").replace("{n}", String(index + 1)).replace("{m}", String(total));
    const title = steps[index]!.getAttribute("data-step-title");
    return title ? `${count} · ${title}` : count;
  };
  const render = (): void => {
    steps.forEach((step, i) => {
      const shown = expanded || i === index;
      step.classList.toggle("is-active", i === index);
      step.toggleAttribute("inert", !shown);
      step.setAttribute("aria-hidden", shown ? "false" : "true");
    });
    status.textContent = statusText();
    prev.disabled = index === 0;
    next.disabled = index === total - 1;
    all.textContent = expanded ? word(root, "collapse", "One at a time") : word(root, "expand", "Show all");
    all.setAttribute("aria-pressed", String(expanded));
    root.classList.toggle("is-expanded", expanded);
  };
  const go = (to: number): void => {
    if (to < 0 || to >= total || to === index) return;
    flip?.finish();
    const from = steps[index]!;
    index = to;
    render();
    flip = expanded ? null : playStepChange(from, steps[index]!, reducedMotion(doc));
  };

  const onClick = (e: Event): void => {
    if (e.target instanceof Node && prev.contains(e.target)) go(index - 1);
    else if (e.target instanceof Node && next.contains(e.target)) go(index + 1);
    else if (e.target instanceof Node && all.contains(e.target)) { flip?.finish(); expanded = !expanded; render(); }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
    // Inside a step the page's own keys stay: Home/End/Page keys scroll a code block or a link's page.
    if (t?.closest(".md-steps-stage") && !e.key.startsWith("Arrow")) return;
    const to = expanded ? null : stepForKey(e.key, index, total);
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  let startX = 0;
  let startY = 0;
  let inScroller = false;
  const onStart = (e: TouchEvent): void => {
    startX = e.changedTouches[0]!.clientX;
    startY = e.changedTouches[0]!.clientY;
    // A touch that starts on a code block wide enough to scroll sideways is the reader scrolling the code.
    inScroller = e.target instanceof Element && scrollsSideways(e.target);
  };
  const onEnd = (e: TouchEvent): void => {
    if (expanded || inScroller) return;
    const move = swipeStep(e.changedTouches[0]!.clientX - startX, e.changedTouches[0]!.clientY - startY);
    if (move !== 0) go(index + move);
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  const stage = root.querySelector<HTMLElement>(".md-steps-stage")!;
  stage.addEventListener("touchstart", onStart, { passive: true });
  stage.addEventListener("touchend", onEnd, { passive: true });
  render();

  return () => {
    flip?.finish();
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKey);
    stage.removeEventListener("touchstart", onStart);
    stage.removeEventListener("touchend", onEnd);
    bar.remove();
    root.classList.remove("is-player", "is-expanded");
    root.removeAttribute("tabindex");
    for (const step of steps) { step.classList.remove("is-active"); step.removeAttribute("inert"); step.removeAttribute("aria-hidden"); }
  };
}

/** Wire every figure under `root` (the site's pages call this once). */
export function installStepsPlayers(root: ParentNode = document): void {
  for (const figure of root.querySelectorAll<HTMLElement>(`.${STEPS_CLASS}[data-steps]`)) installStepsPlayer(figure);
}
