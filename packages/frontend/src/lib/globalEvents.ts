// The one place screens listen to, or send, events on `window` / `document`
// (allowlist: screens do not touch those globals). Every function returns or
// pairs with the undo so an effect is `return onWindow("keydown", handler)`.

type ListenOptions = boolean | AddEventListenerOptions;

type EventOf<K extends string, Map> = K extends keyof Map ? Map[K] : Event;

/** Listen on `window`; returns the unsubscribe (same capture flag is reused to remove). */
export function onWindow<K extends string>(type: K, handler: (event: EventOf<K, WindowEventMap>) => void, options?: ListenOptions): () => void {
  window.addEventListener(type, handler as EventListener, options);
  return () => window.removeEventListener(type, handler as EventListener, options);
}

/** Listen on `document`; returns the unsubscribe. */
export function onDocument<K extends string>(type: K, handler: (event: EventOf<K, DocumentEventMap>) => void, options?: ListenOptions): () => void {
  document.addEventListener(type, handler as EventListener, options);
  return () => document.removeEventListener(type, handler as EventListener, options);
}

/** The window's inner height in CSS px (what a scroll-windowed list measures its viewport by). */
export function windowHeight(): number {
  return window.innerHeight;
}

/** Send an app-level event to whoever listens on `window` (`detail` optional). */
export function emitWindowEvent(name: string, detail?: unknown): void {
  window.dispatchEvent(detail === undefined ? new CustomEvent(name) : new CustomEvent(name, { detail }));
}
