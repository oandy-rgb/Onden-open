import type { PuckComponentData } from "./design.js";
import { PATTERNS, type PatternType } from "./registry.js";

/** What a pattern's slots hold when it is inserted: the part tree it expands
 *  to, with the content the user still has to choose left empty. Ids are
 *  prefixed with `idPrefix` (the pattern's own id) so they stay unique. */
export function patternDefaultSlots(type: PatternType, idPrefix: string = type): Record<string, PuckComponentData[]> {
  const def = PATTERNS[type];
  return Object.fromEntries(
    Object.entries(def.slots).map(([slot, list]) => [
      slot,
      list.map((c, i) => ({ type: c.type, props: { id: `${idPrefix}-${slot}-${i + 1}`, ...c.props } })),
    ]),
  );
}

/** "展開成零件": the pattern component as the plain part it is made of. The
 *  id, props and slot content are kept, so the page does not change. */
export function expandPattern(component: PuckComponentData): PuckComponentData {
  const def = PATTERNS[component.type as PatternType];
  return def ? { type: def.expandsTo, props: component.props } : component;
}
