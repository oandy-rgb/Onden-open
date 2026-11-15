import { useLayoutEffect, useState } from "react";
import { observeSize } from "../lib/observeSize";

/** The element's box in px, `null` until it is laid out. Measures the element a component
 *  sits in rather than the window: a collapsible sidebar or a settings side list changes the room
 *  without the window changing. `node` is state (pass the callback ref's value), so a node that
 *  mounts late is picked up. */
export function useElementSize(node: HTMLElement | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!node) return;
    const read = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize((was) => (was && was.width === width && was.height === height ? was : { width, height }));
    };
    read();
    return observeSize(node, read);
  }, [node]);
  return size;
}
