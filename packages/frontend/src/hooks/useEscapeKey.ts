import { useEffect, useRef } from "react";
import { isEscapeKey } from "../lib/keys";

// ── What leaves a surface: Esc and Back, one stack ───────────────────────────
// A surface the person can leave (a menu, a panel opened over the page, zen mode, an enlarged
// pane, a tool) registers here while it is open. Esc and Back (Android's button or gesture, the
// installed app's) both close only the newest one; the page underneath stays.
//
// Back reaches a page in two ways: history (useUrlLocation owns it) and the browser's close
// request. A native <dialog> (ui/Modal) already answers the close request, and a menu inside it
// must close first, so a surface registered here asks for a CloseWatcher: the browser keeps
// dialogs and watchers in one stack in creation order. Compared with a pushed same-address history
// entry per surface (useHistoryEntry): Chrome sends Back to the newest close watcher or dialog
// *before* history, so an entry pushed for a menu inside a modal is never the one Back reaches,
// and every entry leaves a step in the history that Forward and the long-press list show.
//
// No CloseWatcher (Firefox, jsdom): Esc still works through the window listener below; Back
// leaves the page as it did. The desktop toolbar's Back button is history, not a close request,
// so it navigates as before.

/** The browser's CloseWatcher (Chrome 120+; Samsung Internet and Brave follow Chromium). */
type CloseWatcherLike = { onclose: (() => void) | null; destroy(): void };
type CloseWatcherCtor = new () => CloseWatcherLike;
const closeWatcherCtor = (): CloseWatcherCtor | undefined => (globalThis as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher;

type Handler = { current: (via: KeyboardEvent | "back") => boolean | void };
/** `watcher`: Esc and Back of this entry come as the browser's close request, not through the key listener. */
type Entry = { handler: Handler; back: boolean; watcher: CloseWatcherLike | null };

/** Surfaces that Esc can leave, oldest first. Esc goes to the newest one: a zen page with an
 *  enlarged pane inside it leaves the pane first. */
const stack: Entry[] = [];

function onKey(e: KeyboardEvent) {
  if (!isEscapeKey(e) || e.defaultPrevented) return;
  // A menu, popover or dialog above the page closes itself on Esc (ui/Modal, ui/Popover).
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target?.closest(".ui-popover, dialog")) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    // The newest surface is a close watcher's: the browser's close request, which this key press
    // still makes, takes it. (Declining is not possible there: Back cannot decline either.)
    if (stack[i].watcher) return;
    if (stack[i].handler.current(e) !== false) {
      // Spoken for: the close request this key press makes must not also close a watcher below.
      e.preventDefault();
      return;
    }
  }
}

function register(handler: Handler, back: boolean): () => void {
  const Watcher = back ? closeWatcherCtor() : undefined;
  let watcher: CloseWatcherLike | null = null;
  try {
    watcher = Watcher ? new Watcher() : null;
  } catch { watcher = null; }
  if (watcher) watcher.onclose = () => { handler.current("back"); };
  const entry: Entry = { handler, back, watcher };
  if (stack.length === 0) window.addEventListener("keydown", onKey);
  stack.push(entry);
  return () => {
    watcher?.destroy();
    stack.splice(stack.indexOf(entry), 1);
    if (stack.length === 0) window.removeEventListener("keydown", onKey);
  };
}

/**
 * Esc leaves this surface (a tool, a gesture's hint) while `enabled`.
 * The one window-level Esc listener, so two open surfaces never both react to
 * the same press. `onEscape` may return false to decline (a text field has
 * focus, the wrong tool is active) and let the next surface down take it.
 * Surfaces that Back must leave too use `useDismiss`.
 */
export function useEscapeKey(onEscape: (e: KeyboardEvent) => boolean | void, enabled = true): void {
  const handler = useRef(onEscape) as Handler;
  handler.current = onEscape as Handler["current"];
  useEffect(() => (enabled ? register(handler, false) : undefined), [enabled]);
}

/**
 * Esc and Back both leave this surface while `open`: only the newest registered surface hears them
 * (see the notes at the top of this block). `onDismiss` gets the key event, or "back"; it may return
 * false for an Esc it declines (a text field has focus) — a Back cannot be declined. It must close
 * the surface; the registration ends when `open` turns false.
 */
export function useDismiss(onDismiss: (via: KeyboardEvent | "back") => boolean | void, open: boolean): void {
  const handler = useRef(onDismiss);
  handler.current = onDismiss;
  useEffect(() => (open ? register(handler, true) : undefined), [open]);
}

/** Handlers that must hear Esc even when something else took it first (a text editor with focus handles
 *  Esc itself and marks it as handled). Heard in the capture phase, before anyone else, and never take the key. */
const cancelStack: Array<{ current: () => void }> = [];
function onKeyCapture(e: KeyboardEvent) {
  if (!isEscapeKey(e)) return;
  for (const handler of [...cancelStack]) handler.current();
}

/**
 * Esc cancels a gesture in progress (a drag) while `enabled`, wherever focus is: unlike `useEscapeKey` it is
 * not skipped when the focused control already used the key. The key still reaches the control afterwards.
 */
export function useEscapeCancel(onCancel: () => void, enabled = true): void {
  const handler = useRef(onCancel);
  handler.current = onCancel;
  useEffect(() => {
    if (!enabled) return;
    if (cancelStack.length === 0) window.addEventListener("keydown", onKeyCapture, true);
    cancelStack.push(handler);
    return () => {
      cancelStack.splice(cancelStack.indexOf(handler), 1);
      if (cancelStack.length === 0) window.removeEventListener("keydown", onKeyCapture, true);
    };
  }, [enabled]);
}
