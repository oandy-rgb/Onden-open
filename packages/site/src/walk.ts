import type { PuckComponentData, PuckData } from "./design.js";
import { slotsOf } from "./registry.js";

export type WalkInfo = {
  /** 1 for a top-level component. */
  depth: number;
  parent: PuckComponentData | null;
  /** The slot of `parent` this component sits in; null at the top level. */
  slot: string | null;
};

/** Visit every component of the home page, parents before children, slots in
 *  their registry order. Only the slots of the component's type are read. */
export function walkHome(home: PuckData, fn: (component: PuckComponentData, info: WalkInfo) => void): void {
  const visit = (list: PuckComponentData[], parent: PuckComponentData | null, slot: string | null, depth: number) => {
    for (const component of list) {
      fn(component, { depth, parent, slot });
      for (const name of slotsOf(component.type)) {
        const children = component.props[name];
        if (Array.isArray(children)) visit(children as PuckComponentData[], component, name, depth + 1);
      }
    }
  };
  visit(home.content, null, null, 1);
}
