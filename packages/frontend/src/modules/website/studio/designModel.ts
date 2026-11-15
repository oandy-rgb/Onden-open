// The home studio's design, as plain data: where the saved design comes from,
// what may be saved, and the editing moves (insert, replace, remove) the panels
// make. No React and no Puck here — the nesting rules are the ones in
// @onden/site (the same registry validateDesignV2 reads), so the studio and the
// server cannot disagree about what a home page may hold.
import {
  COMPONENTS_MAX,
  allowedAt, defaultDesignV2, kindOf, legacyDesignOf, slotsOf, validateDesign, validateDesignV2, walkHome, withLegacyDesign,
  type DefaultDesignInput, type Place as NestingPlace, type PuckComponentData, type PuckData, type SiteDesign, type SiteDesignV2,
} from "@onden/site";
import { randomUUID } from "../../../lib/uuid";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored chrome is a site design only when it says so (v2, or v3 since the box model); anything older is "no design". */
export function isDesignChrome(chrome: unknown): boolean {
  return isObj(chrome) && (chrome.v === 2 || chrome.v === 3);
}

/** The home studio's working copy of the design to open on: the stored design's free-form home
 *  page (the v2 default one when it has none), its style, CSS and date tags — cleaned by the same
 *  validator the server runs. `saved` is false for the default: it is only written when the owner
 *  changes something. The rest of the design (the boxes) is not the studio's; `designForSave` keeps it. */
export function designFromChrome(chrome: unknown, fallback: DefaultDesignInput): { design: SiteDesignV2; saved: boolean } {
  if (!isDesignChrome(chrome)) return { design: defaultDesignV2(fallback), saved: false };
  return { design: legacyDesignOf(validateDesign(chrome).design, fallback), saved: true };
}

/** What may be sent to the server: the stored design (`current`, the chrome now stored) with the
 *  studio's changes laid over it, after validateDesign. Saving the raw editor state is never done,
 *  so an invalid design cannot be saved; the boxes the owner chose are never overwritten. */
export function designForSave(current: unknown, design: SiteDesignV2): SiteDesign {
  return validateDesign(withLegacyDesign(validateDesign(current).design, validateDesignV2(design).design)).design;
}

/** Whether two homes hold the same page: Puck rewrites the data it loads with
 *  its own key order, which is not a change. */
export function sameHome(a: PuckData, b: PuckData): boolean {
  return JSON.stringify(canonical(a.content)) === JSON.stringify(canonical(b.content));
}

/** Whether two designs say the same thing, whatever their `rev`: this tab's
 *  own save coming back under its new rev is not a change. */
export function sameDesign(a: SiteDesignV2, b: SiteDesignV2): boolean {
  const body = ({ home, style, css, frames }: SiteDesignV2) => JSON.stringify(canonical({ home: home.content, style, css, frames }));
  return body(a) === body(b);
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
  : isObj(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;

// ── Nesting rules in the editor ──────────────────────────────────────────

/** Where a component at `depth` (1 = top level) under `parent` sits. */
function placeAt(depth: number, parent: PuckComponentData | null): NestingPlace {
  if (depth === 1) return "top";
  return parent && depth === 2 && kindOf(parent.type) === "part" ? "outer" : "inner";
}

export type NestingViolation = { componentId: string; type: string; reason: "nesting" | "too_many" };

/** The first component that sits where the registry does not allow it, or
 *  null. Puck takes its slot `allow` lists from the static config (one list per
 *  component type, whatever depth it sits at; `resolveFields` does not change
 *  what a drop accepts), so depth-dependent rules are checked here instead.
 *  Content may sit on the top level (allowedAt). */
export function nestingViolation(home: PuckData): NestingViolation | null {
  let count = 0;
  let found: NestingViolation | null = null;
  walkHome(home, (component, { depth, parent }) => {
    count++;
    if (found) return;
    const type = component.type;
    const place = placeAt(depth, parent);
    if (kindOf(type) === null || !allowedAt(place, type)) found = { componentId: component.props.id, type, reason: "nesting" };
  });
  if (found) return found;
  if (count > COMPONENTS_MAX) return { componentId: "", type: "", reason: "too_many" };
  return null;
}

export function homeComponentIds(home: PuckData): Set<string> {
  const ids = new Set<string>();
  walkHome(home, (component) => { ids.add(component.props.id); });
  return ids;
}

function freshId(type: string, taken: Set<string>): string {
  for (;;) {
    const id = `${type}-${randomUUID()}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

// ── Editing moves ────────────────────────────────────────────────────────

/** A deep copy of `component` whose ids (and its children's) are new, so a
 *  template inserted twice never repeats an id. */
export function withFreshIds(component: PuckComponentData, taken: Set<string>): PuckComponentData {
  const props: PuckComponentData["props"] = { ...component.props, id: freshId(component.type, taken) };
  for (const slot of slotsOf(component.type)) {
    const children = props[slot];
    if (Array.isArray(children)) props[slot] = (children as PuckComponentData[]).map((child) => withFreshIds(child, taken));
  }
  return { type: component.type, props };
}

type Place = { list: PuckComponentData[]; index: number; parent: PuckComponentData | null; depth: number };

function locate(home: PuckData, id: string): Place | null {
  const search = (list: PuckComponentData[], parent: PuckComponentData | null, depth: number): Place | null => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index]!;
      if (item.props.id === id) return { list, index, parent, depth };
      for (const slot of slotsOf(item.type)) {
        const children = item.props[slot];
        const hit = Array.isArray(children) ? search(children as PuckComponentData[], item, depth + 1) : null;
        if (hit) return hit;
      }
    }
    return null;
  };
  return search(home.content, null, 1);
}

export function findComponent(home: PuckData, id: string): PuckComponentData | null {
  const place = locate(home, id);
  return place ? place.list[place.index]! : null;
}

function accepts(type: string, parent: PuckComponentData | null, depth: number): boolean {
  return allowedAt(placeAt(depth, parent), type);
}

/** Insert `component` after the selected one (the same slot when it fits
 *  there, else after the closest ancestor it fits beside), or at the end of the
 *  page. Returns the new home and the component as inserted (new ids). */
export function insertAfter(home: PuckData, selectedId: string | null, component: PuckComponentData): { home: PuckData; inserted: PuckComponentData } {
  const copy: PuckData = structuredClone(home);
  const inserted = withFreshIds(component, homeComponentIds(copy));
  let place = selectedId ? locate(copy, selectedId) : null;
  while (place) {
    if (accepts(inserted.type, place.parent, place.depth)) {
      place.list.splice(place.index + 1, 0, inserted);
      return { home: copy, inserted };
    }
    place = place.parent ? locate(copy, place.parent.props.id) : null;
  }
  copy.content.push(inserted);
  return { home: copy, inserted };
}

/** The home with the props of one component changed. */
export function updateProps(home: PuckData, id: string, patch: Record<string, unknown>): PuckData {
  const copy: PuckData = structuredClone(home);
  const place = locate(copy, id);
  if (!place) return home;
  const item = place.list[place.index]!;
  item.props = { ...item.props, ...patch };
  return copy;
}

export function removeComponent(home: PuckData, id: string): PuckData {
  const copy: PuckData = structuredClone(home);
  const place = locate(copy, id);
  if (!place) return home;
  place.list.splice(place.index, 1);
  return copy;
}
