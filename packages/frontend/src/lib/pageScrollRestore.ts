// Back and Forward return a page to where it was scrolled when the person left it.
//
// The rule (owner decision 2026-11-18): the position belongs to the HISTORY ENTRY (hooks/useUrlLocation
// writes an id into every entry), not to the note: the same note visited twice in the trail has two
// positions. Back and Forward put the page back where that entry was left; a note opened any other way
// (the list, search, the palette, a link) starts at the top, and so does a reload (the memory is this
// session's, in memory only: no storage, no sync, nothing written to the note). A target the opening
// asks for (a line to reveal, words to find, a caret handoff) is explicit and always wins over a
// remembered position.
//
// What scrolls, found by measuring the layout (not guessed): on a desktop the note page's scroller is the
// one element `.obsidian-main.note-document` (the editor's own `.cm-scroller` and the preview's
// `.obsidian-preview` do not scroll in the page), marked `data-scroll-memory`; on a phone the window
// scrolls. The side-by-side pane has no history of its own and is not covered. Anything else that scrolls
// inside a page (lists, panels) is not remembered.
//
// A step through history reads the page's live position first, because the scroll events of what the person did last
// can be delivered only after the screen has been replaced.
//
// Switching lens inside a note (editor ↔ preview) is no history step. Each lens has its own scroller name
// ("note-edit", "note-preview"), so only the lens an entry was left in is put back.

/** The `data-scroll-memory` value of the window's scroll. */
const WINDOW = "window";
/** Entries remembered, oldest forgotten first: the link trail keeps 50 too. */
const MAX_REMEMBERED_ENTRIES = 50;
/** A step through history is followed by its screen at once; a mark that nothing used is no longer one. */
const STEP_LAPSE_MS = 1000;
/** The body is fetched lazily and images change heights: wait this long for the page to be tall enough. */
const RESTORE_TIMEOUT_MS = 4000;

type LeftAt = { screen: string; positions: Map<string, number> };
const left = new Map<string, LeftAt>();

/** Record where a scroller of an entry's screen is. The newest entry is the last to be forgotten. */
function rememberScroll(entry: string, screen: string, scroller: string, y: number): void {
  let record = left.get(entry);
  if (record?.screen !== screen) record = { screen, positions: new Map() }; // the entry shows another page now (a note replaced)
  record.positions.set(scroller, Math.max(0, Math.round(y)));
  left.delete(entry);
  left.set(entry, record);
  if (left.size > MAX_REMEMBERED_ENTRIES) left.delete(left.keys().next().value as string);
}

export function clearPageScrollMemory(): void {
  left.clear();
  step = null;
  claimedNote = null;
}

// ── A step through history ───────────────────────────────────────────────
// "entry": the browser's history went to an entry (popstate: Back, Forward, Alt+←/→, a side button, the phone's
// ‹); history.state is already that entry's. "in place": the app showed an earlier page without a history
// entry of its own to go to (a deleted note's list, the trail stepped in state alone); the page it shows is the
// latest one of that name that was left.
type HistoryStep = "entry" | "in place";
let step: { how: HistoryStep; at: number } | null = null;

/** Call right before the state change of every Back or Forward; the next screen change consumes it. */
export function markHistoryStep(how: HistoryStep): void {
  // The screen about to be left is still in the page, and the scroll events of what the person did last may be
  // delivered only after it has been replaced (and are then nobody's): read where it is now.
  const here = shownScreen?.();
  if (here) rememberLiveScroll(here);
  // The browser's step arrives first and the link trail then takes its own step in state: that is the same step, and the
  // entry is the better answer.
  if (step?.how === "entry" && Date.now() - step.at <= STEP_LAPSE_MS) return;
  step = { how, at: Date.now() };
}

function remembered(entry: string | null, screen: string, how: HistoryStep): Map<string, number> | null {
  const own = entry === null ? undefined : left.get(entry);
  if (own?.screen === screen) return own.positions;
  if (how === "entry") return null; // an entry nobody scrolled: its page starts at the top, whatever else was left
  for (const record of [...left.values()].reverse()) if (record.screen === screen) return record.positions;
  return null;
}

// ── Who owns the scroll of a note while it is put back ───────────────────
// The editor puts its own caret in view when a note opens; after a Back that would undo the restore a
// moment later. The note whose position was put back is claimed until the next screen.
let claimedNote: string | null = null;

/** Whether a Back or Forward put this note's scroll back: the caret's own scroll-into-view stays out of it. */
export function scrollClaimedFor(noteId: string): boolean {
  return claimedNote === noteId;
}

/**
 * The screen just committed (call it in a layout effect: the page then shows at the right place from its
 * first paint). After a Back or Forward to an entry whose position was remembered, put it back; every
 * other arrival does nothing. `explicitTarget`: the opening asks for a place of its own, which wins. The
 * step mark is used up either way. Returns the stop.
 */
export function arriveAtScreen(opts: { entry: string | null; screen: string; noteId: string | null; explicitTarget: boolean }): () => void {
  claimedNote = null;
  const stepped = step;
  step = null;
  const positions = stepped && Date.now() - stepped.at <= STEP_LAPSE_MS && !opts.explicitTarget ? remembered(opts.entry, opts.screen, stepped.how) : null;
  const wanted = positions ? [...positions].filter(([, y]) => y > 0) : [];
  if (wanted.length === 0) {
    startAtTop();
    return () => {};
  }
  claimedNote = opts.noteId;
  return restoreWhenTall(wanted, RESTORE_TIMEOUT_MS);
}

/** The page that opens is put at the top: the note page's scroller outlives the note it shows (the editor only swaps what
 *  it is given) and the phone's window outlives the screen, so each would keep the scroll of what it replaced. */
function startAtTop(): void {
  for (const el of document.querySelectorAll("[data-scroll-memory]")) if (el.scrollTop !== 0) el.scrollTop = 0;
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}

// ── Remembering ──────────────────────────────────────────────────────────
function scrollerNameOf(target: EventTarget | null): string | null {
  if (target === document || target === window) return WINDOW;
  return target instanceof Element ? target.getAttribute("data-scroll-memory") : null;
}

let shownScreen: (() => Where | null) | null = null;
type Where = { entry: string; screen: string };

/** Where every scroller of the page is, now, under the screen it belongs to. */
function rememberLiveScroll(here: Where): void {
  rememberScroll(here.entry, here.screen, WINDOW, window.scrollY);
  for (const el of document.querySelectorAll("[data-scroll-memory]")) rememberScroll(here.entry, here.screen, el.getAttribute("data-scroll-memory")!, el.scrollTop);
}

/** Listen to every scroll on the page (one capturing listener: scroll does not bubble) and record the marked
 *  scrollers and the window under `current()`; null = a screen is changing, its scroll events are not any
 *  page's. Returns the stop. */
export function watchScrolling(current: () => Where | null): () => void {
  shownScreen = current;
  const onScroll = (event: Event) => {
    const name = scrollerNameOf(event.target);
    const here = name === null ? null : current();
    if (name === null || here === null) return;
    const y = name === WINDOW ? window.scrollY : (event.target as Element).scrollTop;
    rememberScroll(here.entry, here.screen, name, y);
  };
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    shownScreen = null;
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}

// ── Putting back ─────────────────────────────────────────────────────────
interface Scroller { max(): number; position(): number; to(y: number): void }

const windowScroller: Scroller = {
  max: () => document.documentElement.scrollHeight - window.innerHeight,
  position: () => window.scrollY,
  to: (y) => window.scrollTo(0, y),
};

function elementScroller(el: Element): Scroller {
  return { max: () => el.scrollHeight - el.clientHeight, position: () => el.scrollTop, to: (y) => { el.scrollTop = y; } };
}

function findScroller(name: string): Scroller | null {
  if (name === WINDOW) return windowScroller;
  const el = document.querySelector(`[data-scroll-memory="${name}"]`);
  return el ? elementScroller(el) : null;
}

/**
 * Scroll each named scroller to its target: at once when it is already tall enough (call it where the screen
 * is committed, before the browser paints, or the page shows for a frame at the wrong place), else on each
 * frame while it grows (the note's body is fetched after the screen is up, the preview draws after load, a
 * windowed list's spacers only give their height once measured). A scroller that is not there yet is waited
 * for too. Gives up when the person scrolls, presses a key or touches the page, or after `timeoutMs`: it
 * never fights them. Returns the stop.
 */
function restoreWhenTall(targets: readonly (readonly [name: string, y: number])[], timeoutMs: number): () => void {
  if (typeof window === "undefined") return () => {};
  const pending = new Map<string, { y: number; lastSet: number }>(targets.map(([name, y]) => [name, { y, lastSet: -1 }]));
  let frame = 0;
  const started = performance.now();
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const finish = () => {
    pending.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const type of events) window.removeEventListener(type, finish, true);
  };
  const tick = () => {
    frame = 0;
    for (const [name, want] of pending) {
      const scroller = findScroller(name);
      if (!scroller) continue;
      const max = scroller.max();
      if (max >= want.y) {
        scroller.to(want.y);
        // The scroll can shift a windowed list (spacers re-render); confirm on the next frame before stopping.
        if (want.lastSet === want.y && Math.abs(scroller.position() - want.y) <= 1) pending.delete(name);
        want.lastSet = want.y;
      } else if (max > scroller.position()) {
        scroller.to(max);
      }
    }
    if (pending.size === 0 || performance.now() - started > timeoutMs) return finish();
    frame = requestAnimationFrame(tick);
  };
  for (const type of events) window.addEventListener(type, finish, { capture: true, passive: true });
  tick();
  return finish;
}
