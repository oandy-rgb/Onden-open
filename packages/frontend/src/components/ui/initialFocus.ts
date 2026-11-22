// Where focus goes when a modal or sheet opens: the one rule for every ui/Modal and ui/Sheet.
// Except: a SEARCH box (Move to…, Put it in…, settings search) does not get the cursor on a touch screen
// (`pointer: coarse`): the keyboard would cover half the list the person came to pick from (owner, 2026-11-19).
// Focus rests on the dialog itself; a tap on the box brings the keyboard. A box the dialog exists to fill in
// (a name, a task, a feed address) is a text field, not a search box, and still gets the cursor. A dialog that
// opens to look at something with a field in it (edit a task) says `initialFocus="dialog"`.
// (A Popover is not a dialog: its surface keeps focus unless a field inside says `autoFocus`, which works there
// because a popover is displayed when it mounts. A tool panel such as the ink colours must not jump into its code box.)
//
//   1. the main text field — the first one a person can type in;
//   2. else the first control that is not the ✕ (a dialog with only buttons);
//   3. else the browser's own choice.
//
// Why this exists: a closed <dialog> is display:none, so React's `autoFocus` (which runs while the dialog is
// still closed) focuses nothing, and showModal() then runs the browser's dialog focusing steps: focus goes to
// the first focusable thing — the ✕ of the header. A person who opened 「新增任務」 on a tablet and typed got
// nothing, and Enter closed it (owner, Galaxy Tab S9, 2026-11-17; confirmed in Chromium).
// Opening a form to type in puts the cursor in it, on a touch screen too (the on-screen keyboard comes up:
// that is what the person opened the form for). A caller with a better answer passes `initialFocus` (ui/Modal);
// `autoFocus` on a field inside a Modal or Sheet is not needed and not what decides.

import { isCoarsePointer } from "../../lib/mediaQuery";

/** A field a person types text in. Not checkboxes, radios, buttons, dates or files. */
const TEXT_FIELD = [
  "textarea",
  "[contenteditable='true']",
  "input:not([type])",
  ...["text", "search", "email", "url", "tel", "number", "password"].map((type) => `input[type='${type}']`),
].join(", ");

/** What a header's ✕ carries: never the first thing focus lands on. `CloseButton` has it; a ✕ drawn by hand
 *  in a dialog (the settings header) spreads it: `<Pressable {...DISMISS_PROPS} …>`. */
export const DISMISS_PROPS = { "data-dismiss": "" } as const;

const CONTROL = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Displayed, so focus() can land on it: not display:none (CSS or `hidden`) on it or any ancestor, not visibility:hidden. */
function displayed(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || (node === el && style.visibility === "hidden")) return false;
  }
  return true;
}

const usable = (el: HTMLElement) =>
  !el.closest("[hidden], [inert], [aria-hidden='true']") && !(el as HTMLInputElement).disabled && !(el as HTMLInputElement).readOnly && displayed(el);

/** The first text field in `root` a person can type in. */
function primaryField(root: ParentNode): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(TEXT_FIELD)).find(usable) ?? null;
}

/** The first control in `root` that is not a ✕. */
function firstAction(root: ParentNode): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) => el.matches(CONTROL) && !el.hasAttribute("data-dismiss") && usable(el)) ?? null;
}

/** Puts focus where `root` opened, once it is displayed (after showModal()). */
export function focusInitial(root: HTMLElement): void {
  const field = primaryField(root);
  // The dialog takes it (tabIndex -1) so the ✕ native showModal() chose is not left focused.
  if (field?.matches("input[type='search']") && isCoarsePointer()) { root.focus({ preventScroll: true }); return; }
  (field ?? firstAction(root))?.focus({ preventScroll: true });
}
