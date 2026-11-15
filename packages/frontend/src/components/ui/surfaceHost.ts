import { useSyncExternalStore } from "react";

/** Where a floating surface (menu, popover, modal) is rendered. A fullscreen
 *  element hides everything outside it, so a surface opened from inside one
 *  (the PDF reader) has to render inside it. */
export function surfaceHost(): HTMLElement {
  const fullscreen = document.fullscreenElement;
  return fullscreen instanceof HTMLElement ? fullscreen : document.body;
}

const modalLayers: HTMLElement[] = [];
const modalListeners = new Set<() => void>();
const notifyModals = () => modalListeners.forEach((listener) => listener());

/** Modal (ui/Modal) tells which layers are open, bottom first. */
export function trackModalLayer(layer: HTMLElement): () => void {
  modalLayers.push(layer);
  notifyModals();
  return () => { const i = modalLayers.indexOf(layer); if (i >= 0) modalLayers.splice(i, 1); notifyModals(); };
}

/** The top open modal's layer, or null; re-renders when it changes. For what
 *  must stay visible and pressable over a modal (a toast with 「復原」). */
export function useTopModalLayer(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => { modalListeners.add(listener); return () => { modalListeners.delete(listener); }; },
    () => modalLayers[modalLayers.length - 1] ?? null,
  );
}

/** Where a menu or popover is rendered: inside the top open modal when there is
 *  one. A modal is a native <dialog> in the top layer, which paints above
 *  everything in <body>, so a menu opened from Settings or any other modal would
 *  be hidden behind it and could not be pressed. */
export function floatingHost(): HTMLElement {
  return modalLayers[modalLayers.length - 1] ?? surfaceHost();
}

/** Where a corner notice renders: `floatingHost()`, kept current as modals open and as
 *  a fullscreen element (PDF reader, handwriting) starts and ends. */
export function useTopLayerHost(): HTMLElement {
  return useSyncExternalStore(
    (listener) => {
      modalListeners.add(listener);
      document.addEventListener("fullscreenchange", listener);
      return () => { modalListeners.delete(listener); document.removeEventListener("fullscreenchange", listener); };
    },
    floatingHost,
  );
}
