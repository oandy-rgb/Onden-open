import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { classNames } from "../../lib/utils";
import { isImeComposing } from "../../lib/keys";
import { matchShortcut } from "../../lib/shortcuts";
import { surfaceHost, trackModalLayer } from "./surfaceHost";
import { focusInitial } from "./initialFocus";
import "./ui.css";

// Every modal: a native <dialog> opened with showModal(), so the page behind it
// is inert, focus stays inside, and a modal opened from a modal (a confirm
// from Settings, the palette from Version history) stacks on top without
// z-index bookkeeping. The <dialog> is a full-screen transparent layer that
// centres its child; the child is the card and keeps its own class. A press on
// the layer outside the card, or Esc, asks to close — only the top modal's;
// `busy` holds the modal open while an operation owns it.
//
// Keys belong to the top modal while one is open: the page's shortcuts do not
// fire behind it, whether focus is in the card or has fallen to <body>. The
// exception is a shortcut marked `overModals` in lib/shortcuts (the command
// palette), which reaches the page's handler and opens above.
// The eslint rule onden/modals-through-ui-modal keeps every modal on this one.
//
// The modal renders in surfaceHost(): <body>, or the fullscreen element while
// one is up (a confirm opened inside the fullscreen PDF), and follows it when
// fullscreen starts or ends.
//
// A ui/Menu or Popover opened from inside a Modal renders inside that modal's
// layer (floatingHost), above the card; elsewhere it renders in the page.

/** Open modals, bottom first. The last one owns the keyboard. */
const openModals: HTMLDialogElement[] = [];
/** The page's own body overflow, put back when the last modal closes. Kept
 *  here, not per modal: stacked modals may close in any order (a palette
 *  command can close the history under it in the same render). */
let pageOverflow = "";

function opensOverModals(e: KeyboardEvent): boolean {
  return matchShortcut(e)?.overModals === true;
}

// A key whose target is outside the top modal (focus fell to <body>, or a
// test dispatched it on window) would reach the page's window and document
// listeners: stop it first. Installed while any modal is open; capture on
// window runs before every other listener. Not cancelled, so Esc still asks
// the top modal to close.
function guardPageKeys(e: KeyboardEvent) {
  const top = openModals[openModals.length - 1];
  if (!top || (e.target instanceof Node && top.contains(e.target))) return;
  if (opensOverModals(e)) return;
  e.stopImmediatePropagation();
}

function pushModal(dialog: HTMLDialogElement) {
  if (openModals.length === 0) {
    window.addEventListener("keydown", guardPageKeys, true);
    pageOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openModals.push(dialog);
}

function removeModal(dialog: HTMLDialogElement) {
  const i = openModals.indexOf(dialog);
  if (i < 0) return;
  openModals.splice(i, 1);
  if (openModals.length === 0) {
    window.removeEventListener("keydown", guardPageKeys, true);
    document.body.style.overflow = pageOverflow;
  }
}

type Props = {
  /** Accessible name. */
  label: string;
  /** alertdialog for a question that must be answered (confirm, alert). */
  role?: "dialog" | "alertdialog";
  /** Class on the full-screen layer (placement, backdrop tint, test hooks). */
  className?: string;
  /** Holds the modal open (no Esc, no press outside) and marks it aria-busy. */
  busy?: boolean;
  onClose: () => void;
  /** Focused on open: a control, or "dialog" for the dialog itself (nothing inside, so no keyboard comes up);
   *  otherwise the main text field, else the first control that is not the ✕ (ui/initialFocus). */
  initialFocus?: RefObject<HTMLElement | null> | "dialog";
  children: ReactNode;
};

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function Modal({ label, role = "dialog", className, busy = false, onClose, initialFocus, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read while rendering: an autoFocus field inside takes focus during the commit, before any effect runs.
  const [opener] = useState(() => document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  const holding = useRef(busy);
  holding.current = busy;
  // A press that starts in the card and ends on the layer (selecting text) is not "outside".
  const pressedLayer = useRef(false);
  // The portal target: a wrapper that moves between hosts, so the card (and its
  // state) is not remounted by fullscreen changes.
  const [holder] = useState(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    return el;
  });
  const moving = useRef(false);
  // Connected before the children commit: React focuses an autoFocus child
  // during commit, ahead of every effect, and a detached node cannot take
  // focus. Never re-append a holder already in place: appendChild moves the
  // node, which blurs whatever inside it has focus.
  if (!holder.isConnected) surfaceHost().appendChild(holder);

  useLayoutEffect(() => {
    if (holder.parentNode !== surfaceHost()) surfaceHost().appendChild(holder);
    const follow = () => {
      const host = surfaceHost();
      if (holder.parentNode === host) return;
      const dialog = ref.current;
      // Re-parenting drops the dialog from the top layer but leaves `open`
      // set; clear it (no close event) and open modally again.
      moving.current = true;
      host.appendChild(holder);
      if (dialog?.isConnected) {
        dialog.removeAttribute("open");
        dialog.showModal();
      }
      moving.current = false;
    };
    document.addEventListener("fullscreenchange", follow);
    return () => {
      document.removeEventListener("fullscreenchange", follow);
      holder.remove();
    };
  }, [holder]);

  useEffect(() => {
    const dialog = ref.current!;
    let unmounting = false;
    // Chrome closes a dialog on a second Esc without asking (cancel is not
    // cancelable twice without a user gesture). Keep React the owner.
    const onNativeClose = () => {
      if (unmounting || moving.current) return;
      if (holding.current) dialog.showModal();
      else close.current();
    };
    dialog.addEventListener("close", onNativeClose);
    dialog.showModal();
    pushModal(dialog);
    const untrack = trackModalLayer(dialog);
    if (initialFocus === "dialog") dialog.focus({ preventScroll: true });
    else if (initialFocus?.current) initialFocus.current.focus();
    else focusInitial(dialog);
    return () => {
      untrack();
      unmounting = true;
      dialog.removeEventListener("close", onNativeClose);
      removeModal(dialog);
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- opens once per mount; initialFocus is read on open only

  const dialog = (
    <dialog ref={ref} tabIndex={-1} className={classNames("ui-modal", className)} role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-label={label} aria-modal="true" aria-busy={busy || undefined}
      // React bubbles a nested modal's cancel up through the portal: only our own Esc closes us.
      onCancel={(e) => { if (e.target !== e.currentTarget) return; e.preventDefault(); if (!busy) onClose(); }}
      onPointerDown={(e) => { pressedLayer.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedLayer.current && !busy) onClose(); }}
      onKeyDown={(e) => {
        // Keys typed in a modal are the modal's, not the page's shortcuts.
        if (!opensOverModals(e.nativeEvent)) e.stopPropagation();
        // Esc while an IME composes cancels the composition, not the modal
        // (a cancelled keydown sends the dialog no close request).
        if (e.key === "Escape" && isImeComposing(e)) { e.preventDefault(); return; }
        if (e.key !== "Tab") return;
        // Filter in document order: jsdom returns a selector list's matches grouped by selector.
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("*")).filter((el) => el.matches(FOCUSABLE));
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { e.preventDefault(); return; }
        const active = document.activeElement;
        // Focus on the layer or on a card focused on open (tabIndex -1), ahead of every control.
        const ahead = !!active && !controls.includes(active as HTMLElement)
          && (active === e.currentTarget || !!(active.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (e.shiftKey && (active === first || ahead)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || ahead)) { e.preventDefault(); first.focus(); }
      }}>
      {children}
    </dialog>
  );
  return createPortal(dialog, holder);
}
