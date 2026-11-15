// Attribute provenance (sync-protocol §2 / §7 step 1, architecture-debt #1).
//
// Every node_attributes row + every ATTRIBUTE_SET event records WHICH input rail
// wrote it, so a multi-source merge can tie-break deterministically by source
// instead of "whoever's write landed last."
//
// Canonical (spec) vocabulary — sync-protocol.md §2:
//   ui          — explicit edits via the attributes panel / inline-props UI
//                 (the PUT /:id/attributes/:key route, human actor).
//   markdown    — body-inline attrs extracted from the note body
//                 (#key=value, key:: value, [key:: value]).
//   frontmatter — YAML frontmatter block at the top of the body.
//   dispatcher  — agent / tag-behaviour automation (the dispatcher rail), incl.
//                 an agent hitting the PUT route directly.
//
// Two more values are stored:
//   derived     — a value Onden computes itself, not typed by a person: a
//                 field's declared default, a collection row's status, an
//                 import's `_import_*` stamps. Still written (it ranks as
//                 markdown, below a person's value).
//   explicit    — LEGACY alias of ui: what person-set values were written as
//                 before this taxonomy (and until D106 by Collections, the
//                 bookmark route, RSS, papers, boards, site settings and the
//                 app). Valid in the DB CHECK constraint (migration 067) and
//                 still read as ui everywhere (ranking, isPersonAuthored), but
//                 never written for a new value: write `ui` (PERSON_SOURCE).
export type AttributeSource = "ui" | "markdown" | "frontmatter" | "dispatcher";

/** Every source a writer may store for a new value (D106): the canonical four
 *  plus `derived`. `explicit` is read-only legacy. */
export type AttributeWriteSource = AttributeSource | "derived";

/** What a value a person typed or chose (an attributes panel, a table cell,
 *  Website › Collections, a bookmark, a feed's settings, a paper they
 *  imported, a board they arranged, site settings) is written as. */
export const PERSON_SOURCE = "ui" satisfies AttributeWriteSource;

/** Sources whose value a person authored: set in the UI (ui, legacy
 *  explicit) or in the note's YAML frontmatter. Body-inline values
 *  (markdown), automation (dispatcher) and what Onden computes (derived)
 *  follow their source and are not. One list for every reader that asks "is
 *  this a person's value?" — the zip export's frontmatter, a duplicate's
 *  copied attributes, an import's local-change baseline (D106). */
export const PERSON_AUTHORED_SOURCES: readonly string[] = ["ui", "explicit", "frontmatter"];

/** True iff a row with this source holds a value a person authored (see
 *  PERSON_AUTHORED_SOURCES). An unknown or missing source is not. */
export function isPersonAuthored(source: string | null | undefined): boolean {
  return !!source && PERSON_AUTHORED_SOURCES.includes(source);
}

/** A stored source as a new row writes it: legacy `explicit` becomes `ui`
 *  (a copy of an old person-set value is still a person's value). */
export function writableSource(stored: string): AttributeWriteSource {
  return stored === "explicit" ? PERSON_SOURCE : stored as AttributeWriteSource;
}

// Deterministic merge tie-break order for a per-key attribute conflict
// (sync-protocol.md §5). HIGHER number = wins. An explicit human UI edit must
// never be silently clobbered by a lower-priority rail (esp. the dispatcher);
// frontmatter (file-level, user-authored) outranks body-inline markdown, which
// outranks dispatcher automation.
//
//   ui > frontmatter > markdown > dispatcher
//
// Legacy values are folded onto their canonical equivalents so a stored
// 'explicit'/'derived' row still ranks correctly.
export const SOURCE_PRIORITY: Record<string, number> = {
  ui: 4,
  explicit: 4, // legacy alias of ui
  frontmatter: 3,
  markdown: 2,
  derived: 2, // Onden-computed: ranks as markdown
  dispatcher: 1,
};

// Default for an unknown / unspecified source (neutral, lowest). Used only for
// tie-break ranking; never written as a stored value.
const UNKNOWN_PRIORITY = 0;

function sourcePriority(source: string | null | undefined): number {
  if (!source) return UNKNOWN_PRIORITY;
  return SOURCE_PRIORITY[source] ?? UNKNOWN_PRIORITY;
}

// True iff an incoming write from `incoming` is allowed to overwrite an existing
// value that was last written by `existing`. Ties (same priority, incl. the same
// source overwriting itself) ALWAYS win for the incoming write — provenance only
// protects a value from being clobbered by a STRICTLY lower-priority rail, so
// single-source rewrites (the common case) are behaviour-preserving.
export function incomingWins(incoming: string, existing: string | null | undefined): boolean {
  return sourcePriority(incoming) >= sourcePriority(existing);
}
