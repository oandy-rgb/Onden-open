// The edge-type vocabulary every graph view shares (D39): a relation's
// readable name, its colour and whether a person may switch an arrow to it.
// All of it comes from the server's edge manifest (backend
// services/edgeManifest.ts, GET /api/edges/manifest), so a plugin-registered
// type is named and coloured everywhere without touching the frontend. The
// board (hooks/useGraphLayout), the force graph (AllCardsGraph), the Links
// lens (LocalGraphLens) and the arrow menu (ContextMenu) each used to keep
// their own copy, and the copies drifted ("excerpt" vs "excerpt of", two
// different greys for a wikilink).
//
// The manifest is fetched once per page and kept as a device pref
// (PREFS.edgeManifest), so an offline start still has the names; until it
// arrives a type is named from its key ("some_kind" → "some kind") and drawn
// in FALLBACK_EDGE_COLOR.

import { useEffect, useSyncExternalStore } from "react";
import { reads } from "./data";
import { t } from "./i18n";
import { getPrefJson, PREFS, removePref, setPrefJson } from "./prefs";

// What an edge is to the person (derived / manual / suggestion) and where it
// shows: lib/edgeRoles.ts, dependency-free so the store and the published site
// can use it too. Re-exported so app code has one edge vocabulary import.
export {
  edgeRole, drawsOnBoard, drawsInGraph, countsAsBacklink, publishes, canDelete, canRetype,
  existingRelation, DERIVED_ARROW_HINT, type EdgeRole, type EdgeFacts,
} from "./edgeRoles";

export type EdgeKindSpec = {
  kind: string;
  describe: string;
  /** English source text, translated by `label()`. */
  label: string;
  /** `#rrggbb`, readable at 3:1 on both themes (lines and swatches only). */
  color: string;
  arrow: "source-to-target" | "bidirectional" | "none";
  planned?: boolean;
  pickable?: boolean;
  /** A theme colour (`--ac-*`) the canvas and legend resolve at draw time, instead of `color`. */
  colorVar?: string;
};

export type EdgeKinds = {
  /** Every registered type, in registration order. */
  specs: readonly EdgeKindSpec[];
  /** Lines the graph draws from a field, not from `node_edges` (DERIVED_EDGE_KINDS); named and coloured here
   *  so an offline start or an older server's manifest still has them. */
  derived: readonly EdgeKindSpec[];
  spec: (kind: string) => EdgeKindSpec | undefined;
  /** Translated reader-facing name ("連結到"); never the schema name. */
  label: (kind: string) => string;
  color: (kind: string) => string;
  /** Types an arrow's context menu offers, in registration order. */
  pickable: readonly EdgeKindSpec[];
};

/** The kind of the line from a note to a tag it carries (`class_tag_ids`/`label_tag_ids`). */
export const TAG_LINK_KIND = "tag";

/** Graph lines derived from a field of the note, like `parent` (parent_id), which
 *  have no `node_edges` row and so no manifest entry the person could depend on. */
export const DERIVED_EDGE_KINDS: readonly EdgeKindSpec[] = [{
  kind: TAG_LINK_KIND,
  describe: "A note and a tag it carries. Drawn from the note's tags, never stored as an edge.",
  label: "tag",
  color: "#8a94a3",
  colorVar: "--ac-faint",
  arrow: "none",
}];

/** Colour for a type the manifest does not (yet) know. */
export const FALLBACK_EDGE_COLOR = "#7a8796";

function isSpec(v: unknown): v is EdgeKindSpec {
  const s = v as EdgeKindSpec;
  return !!s && typeof s.kind === "string" && typeof s.label === "string" && typeof s.color === "string";
}

/** Builds the lookups over one manifest. Exported for tests. */
export function edgeKindsFrom(specs: readonly EdgeKindSpec[]): EdgeKinds {
  const byKind = new Map([...DERIVED_EDGE_KINDS, ...specs].map((s) => [s.kind, s]));
  return {
    specs,
    derived: DERIVED_EDGE_KINDS,
    spec: (kind) => byKind.get(kind),
    label: (kind) => {
      const s = byKind.get(kind);
      return s ? t(s.label) : t(kind.replace(/_/g, " ").replace(/ link$/, ""));
    },
    color: (kind) => byKind.get(kind)?.color ?? FALLBACK_EDGE_COLOR,
    pickable: specs.filter((s) => s.pickable && !s.planned),
  };
}

function readCache(): EdgeKindSpec[] {
  const cached = getPrefJson(PREFS.edgeManifest);
  return Array.isArray(cached) ? cached.filter(isSpec) : [];
}

let current: EdgeKinds = edgeKindsFrom(readCache());
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(specs: EdgeKindSpec[]) {
  current = edgeKindsFrom(specs);
  setPrefJson(PREFS.edgeManifest, specs);
  for (const l of listeners) l();
}

/** Fetches the manifest once; an unreadable or empty answer keeps what we have. */
export function loadEdgeKinds(): Promise<void> {
  loading ??= reads.workspace.edgeManifest<unknown>()
    .then((m) => {
      const specs = m.filter(isSpec);
      if (specs.length) publish(specs);
      else loading = null; // try again on the next mount
    })
    .catch(() => { loading = null; });
  return loading;
}

/** The current vocabulary (whatever has loaded so far), without subscribing. */
export function edgeKinds(): EdgeKinds {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The vocabulary, re-rendering when the manifest arrives. The returned
 *  object changes identity only then, so it is a safe memo dependency. */
export function useEdgeKinds(): EdgeKinds {
  useEffect(() => { void loadEdgeKinds(); }, []);
  return useSyncExternalStore(subscribe, edgeKinds, edgeKinds);
}

/** Test seam: forget the loaded manifest and the in-flight fetch. */
export function resetEdgeKindsForTest(specs: EdgeKindSpec[] = []) {
  loading = null;
  current = edgeKindsFrom(specs);
  removePref(PREFS.edgeManifest);
}
