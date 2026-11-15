import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTopLayerHost } from "./surfaceHost";

/** Renders `children` inside the top open modal, else the fullscreen element, else <body>.
 *  A modal is a native <dialog> in the top layer, and a fullscreen element is too; both paint
 *  above everything else whatever its z-index. A corner notice that must stay visible and
 *  pressable (a toast, the failed-write recovery banner) goes through here
 *  instead of relying on `position: fixed` plus a z-index. */
export function TopLayerPortal({ children }: { children: ReactNode }) {
  return createPortal(children, useTopLayerHost());
}
