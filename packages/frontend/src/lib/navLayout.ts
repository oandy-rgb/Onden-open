// The navigation layout: which destinations sit directly in the shell's nav,
// and in what order (「釘到導覽列」). Pure rules only; where the layout is kept
// is lib/navLayoutStore, what each id opens is hooks/shellNavigation.
//
// One ordered list serves both layouts. 筆記 is always first and is not in the
// list; 「更多」 (and the phone's central 捕捉) are the bar's own.
//   • The desktop top bar shows the whole list, folding trailing module pages
//     into 「更多 ▾」 by width as before.
//   • The phone's bottom bar shows the first `phone` entries (at most
//     PHONE_PIN_LIMIT). Pinning or unpinning on the phone moves an entry
//     across that cut, so the desktop list keeps its order.
// Everything not shown stays in 「更多」.
//
// A stored layout of null means "never edited": the default below, which is
// the navigation as it was before pins existed, recomputed from what is
// imported and in use now (a new module's page still appears on the desktop
// once it is in use; a feature on but unused waits in 「更多」). Once
// edited, the list holds exactly what the person chose; a module imported
// later starts in 「更多」.
//
// Ids that are no longer candidates (a module that was removed) drop out when
// the layout is resolved, and the entries after them close up. Pruning the
// stored copy is the store's (lib/navLayoutStore), so a module imported again
// does not bring its old pin back.

/** The bottom bar's slots for chosen destinations: five slots less 筆記 and 更多
 *  (Material: 3–5 destinations). The central 捕捉 is an action, not a slot. */
export const PHONE_PIN_LIMIT = 3;

/** Where the phone's bar puts the central 捕捉: the entries (筆記 first) split
 *  around it, the left half the larger on an odd count. MobileNav draws the bar
 *  with this and Settings › 導覽列 previews it with this, so they cannot differ. */
export function splitAroundCapture<T>(bar: readonly T[]): { left: T[]; right: T[] } {
  const middle = Math.floor((bar.length + 1) / 2);
  return { left: bar.slice(0, middle), right: bar.slice(middle) };
}

/** The phone bar a person who never edited it gets: 任務. */
export const DEFAULT_PHONE_PINS: readonly string[] = ["tasks"];

export type NavLayout = {
  /** Destination ids in nav order (筆記 excluded). */
  order: readonly string[];
  /** How many of the first entries the phone's bar shows (0…PHONE_PIN_LIMIT). */
  phone: number;
};

/** Where an edit is made: the phone edits its bar (the first `phone`
 *  entries), the desktop and Settings edit the whole list. */
export type NavSurface = "phone" | "desktop";

/** Destinations a person who never edited the nav does not get in it: the
 *  workspace changes view opens from 更多 (and the command palette). Someone
 *  who pinned it has a stored layout, which keeps it. */
export const DEFAULT_UNPINNED: readonly string[] = ["timeline"];

/** The default layout over `candidates` (every destination in nav order: the
 *  core pages, then the imported modules' pages). `unused` are features that
 *  are on but not in use yet (lib/moduleUse): they wait in 「更多」 until the
 *  person pins them or uses them. */
export function defaultNavLayout(candidates: readonly string[], unused: readonly string[] = []): NavLayout {
  const phone = DEFAULT_PHONE_PINS.filter((id) => candidates.includes(id));
  const rest = candidates.filter((id) => !phone.includes(id) && !DEFAULT_UNPINNED.includes(id) && !unused.includes(id));
  return { order: [...phone, ...rest], phone: phone.length };
}

/** The layout to draw: the stored one (or the default) over today's
 *  candidates. Unknown or repeated ids drop out without leaving a gap. */
export function resolveNavLayout(stored: NavLayout | null, candidates: readonly string[], unused: readonly string[] = []): NavLayout {
  if (!stored) return defaultNavLayout(candidates, unused);
  const available = new Set(candidates);
  const seen = new Set<string>();
  const keep = (id: string) => { if (!available.has(id) || seen.has(id)) return false; seen.add(id); return true; };
  const cut = Math.max(0, Math.min(PHONE_PIN_LIMIT, Math.floor(stored.phone)));
  const head = stored.order.slice(0, cut).filter(keep);
  const rest = stored.order.slice(cut).filter(keep);
  return { order: [...head, ...rest], phone: head.length };
}

export function sameNavLayout(a: NavLayout | null, b: NavLayout | null): boolean {
  if (a === null || b === null) return a === b;
  return a.phone === b.phone && a.order.length === b.order.length && a.order.every((id, i) => b.order[i] === id);
}

/** Whether `id` is in the nav on that surface. */
export function isPinned(layout: NavLayout, id: string, surface: NavSurface): boolean {
  const at = layout.order.indexOf(id);
  return at >= 0 && (surface === "desktop" || at < layout.phone);
}

/** Result of a pin: the new layout, or — when the phone's bar is full — the
 *  entries the person must choose one of to swap out (iOS's tab bar). */
export type PinResult = { layout: NavLayout } | { full: readonly string[] };

/** Pin `id`. On the phone it joins the end of the bar (the list after it keeps
 *  its order) or, when the bar is full, answers which entries could make room.
 *  On the desktop it joins the end of the list. Pinning a pinned id is a no-op. */
export function pinDestination(layout: NavLayout, id: string, surface: NavSurface): PinResult {
  if (isPinned(layout, id, surface)) return { layout };
  if (surface === "desktop") return { layout: { order: [...layout.order, id], phone: layout.phone } };
  if (layout.phone >= PHONE_PIN_LIMIT) return { full: layout.order.slice(0, layout.phone) };
  const rest = layout.order.filter((other) => other !== id);
  return { layout: { order: [...rest.slice(0, layout.phone), id, ...rest.slice(layout.phone)], phone: layout.phone + 1 } };
}

/** The phone's swap: `id` takes `out`'s slot in the bar; `out` moves just
 *  after the bar, so the desktop still shows it. */
export function swapPinned(layout: NavLayout, id: string, out: string): NavLayout {
  const slot = layout.order.indexOf(out);
  if (slot < 0 || slot >= layout.phone || out === id) return layout;
  const bar = layout.order.slice(0, layout.phone).map((other) => other === out ? id : other);
  const rest = layout.order.slice(layout.phone).filter((other) => other !== id);
  return { order: [...bar, out, ...rest], phone: layout.phone };
}

/** Unpin `id`. On the phone it leaves the bar for the first place after it
 *  (still on the desktop); on the desktop it leaves the list. */
export function unpinDestination(layout: NavLayout, id: string, surface: NavSurface): NavLayout {
  const at = layout.order.indexOf(id);
  if (at < 0) return layout;
  const rest = layout.order.filter((other) => other !== id);
  const inBar = at < layout.phone;
  if (surface === "phone") {
    if (!inBar) return layout;
    const phone = layout.phone - 1;
    return { order: [...rest.slice(0, phone), id, ...rest.slice(phone)], phone };
  }
  return { order: rest, phone: inBar ? layout.phone - 1 : layout.phone };
}

/** Move `id` one place up (-1) or down (+1). The phone's cut is a boundary
 *  the entry crosses on its own: moving the first entry after the bar up
 *  joins the bar (swapping with the bar's last entry when it is full), and
 *  moving the bar's last entry down leaves it. Anywhere else it trades places
 *  with its neighbour. `surface: "phone"` keeps the move inside the bar. */
export function moveDestination(layout: NavLayout, id: string, delta: -1 | 1, surface: NavSurface = "desktop"): NavLayout {
  const at = layout.order.indexOf(id);
  if (at < 0) return layout;
  const { phone } = layout;
  if (surface === "phone") {
    const to = at + delta;
    if (at >= phone || to < 0 || to >= phone) return layout;
    return { order: swapAt(layout.order, at, to), phone };
  }
  if (delta === -1 && at === phone && phone < PHONE_PIN_LIMIT) return { order: layout.order, phone: phone + 1 };
  if (delta === 1 && at === phone - 1) return { order: layout.order, phone: phone - 1 };
  const to = at + delta;
  if (to < 0 || to >= layout.order.length) return layout;
  return { order: swapAt(layout.order, at, to), phone };
}

/** Drag-to-reorder. The list is drawn as [bar entries…, the phone's cut,
 *  the other entries…]; dropping `id` before the row now at `index` of that
 *  drawn list (0…its length) moves it there, and the cut moves with the rows.
 *  A bar that would hold more than PHONE_PIN_LIMIT pushes its last entry
 *  past the cut. */
export function placeDestination(layout: NavLayout, id: string, index: number): NavLayout {
  if (!layout.order.includes(id)) return layout;
  const CUT = "\u0000cut";
  const drawn = [...layout.order.slice(0, layout.phone), CUT, ...layout.order.slice(layout.phone)];
  const from = drawn.indexOf(id);
  const rest = drawn.filter((row) => row !== id);
  const to = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index));
  const placed = [...rest.slice(0, to), id, ...rest.slice(to)];
  const cut = placed.indexOf(CUT);
  return { order: placed.filter((row) => row !== CUT), phone: Math.min(cut, PHONE_PIN_LIMIT) };
}

function swapAt(list: readonly string[], a: number, b: number): string[] {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

/** A stored layout read back (local copy or server), or null when it is not
 *  one: anything may have been written by another version. */
export function parseNavLayout(value: unknown): NavLayout | null {
  if (!value || typeof value !== "object") return null;
  const { order, phone } = value as { order?: unknown; phone?: unknown };
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
  if (typeof phone !== "number" || !Number.isInteger(phone) || phone < 0 || phone > PHONE_PIN_LIMIT) return null;
  return { order: order.slice(0, 64) as string[], phone: Math.min(phone, order.length) };
}
