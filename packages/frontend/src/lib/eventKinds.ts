// The event-type vocabulary every event view shares (D31): which kind an
// event code is, its colour, its readable name, its verb and what it changes.
// The event log, a note's history, the inbox and the restore preview each
// used to keep their own copy, and the copies drifted (a tag was purple in
// the log and slate-blue in the inbox; NODE_HIDDEN_CHANGED was a field in one
// view and a note edit in the other).
//
// Colours live in styles/event-kinds.css: `eventKindClass(type)` sets
// `--event-color` for the element and what is inside it.
//
// Whether an event can be restored is not part of this: the server sends it
// per row as `restorable` (backend services/restoreContract.ts, D33).

import { t } from "./i18n";

export type EventKind = "create" | "edit" | "delete" | "tag" | "attr" | "edge" | "publish" | "version" | "other";

const NODE_KINDS: Record<string, EventKind> = {
  NODE_CREATED: "create",
  NODE_RESTORED: "create",
  NODE_UNDELETED: "create",
  NODE_UPDATED: "edit",
  NODE_PROMOTED: "edit",
  NODE_DELETED: "delete",
  NODE_PURGED: "delete",
  NODES_PURGED: "delete",
  // Visibility and the space a note is in are properties of the note, not
  // body edits.
  NODE_HIDDEN_CHANGED: "attr",
  NODE_MOVED_SPACE: "attr",
  NODE_SPACE_CHANGED: "attr",
  // Where a note sits on the graph is a property of the note (one entry per burst of moves).
  GRAPH_POSITION_UPDATED: "attr",
  // An AI's suggestion: filing or turning one down changes nothing in the
  // note; accepting one is the person's edit (its NODE_UPDATED is listed too).
  AI_SUGGESTION_ACCEPTED: "edit",
  // Restoring a full backup adds notes; undoing it takes them away.
  BACKUP_RESTORED: "create",
  BACKUP_RESTORE_UNDONE: "delete",
};

/** Families whose events are a thing's lifecycle, split like a note's:
 *  created/restored, removed/deleted, anything else an edit. */
const LIFECYCLE_FAMILIES = ["TASK_", "SPACE_", "BLOCK_NODE_"];

function lifecycleKind(type: string): EventKind {
  if (/_(CREATED|RESTORED)$/.test(type)) return "create";
  if (/_(DELETED|REMOVED)$/.test(type)) return "delete";
  return "edit";
}

/** The kind of an event code; "other" when it is none of the families below. */
export function eventKind(type: string): EventKind {
  const node = NODE_KINDS[type];
  if (node) return node;
  if (LIFECYCLE_FAMILIES.some((f) => type.startsWith(f))) return lifecycleKind(type);
  if (type.startsWith("NODE_VERSION_")) return "version";
  if (type.startsWith("NODE_")) return "edit";
  if (type.startsWith("TAG_") || type.startsWith("FUNCTION_REF_")) return "tag";
  if (type.startsWith("ATTRIBUTE_")) return "attr";
  if (type.startsWith("EDGE_")) return "edge";
  if (type.startsWith("PUBLISH_") || type.startsWith("SITE_")) return "publish";
  return "other";
}

/** The class that colours an element by the event's kind (styles/event-kinds.css). */
export function eventKindClass(type: string): string {
  return `event-kind-${eventKind(type)}`;
}

/** Readable, translated name for an event code ("編輯筆記"). A code with no
 *  wording yet reads as plain words ("node purged"), never as the code. The
 *  codes are the dictionary keys, so English reads the same way. */
export function eventTypeLabel(type: string): string {
  const label = t(type);
  return label === type ? type.toLowerCase().replace(/_/g, " ") : label;
}

const VERBS: Record<string, string> = {
  NODE_CREATED: "Created", NODE_UPDATED: "Edited", NODE_DELETED: "Deleted",
  NODE_RESTORED: "Restored", TAG_APPLIED: "Tagged", TAG_REMOVED: "Untagged",
  ATTRIBUTE_SET: "Set a field on", ATTRIBUTE_DELETED: "Cleared a field on",
  // An AI's suggestion, filed and then decided (nothing in the note changes until a place is accepted).
  AI_SUGGESTION_CREATED: "Suggested changes to", AI_SUGGESTION_ACCEPTED: "Accepted a suggestion for",
  AI_SUGGESTION_REJECTED: "Turned down a suggestion for",
};

/** The English wording of an event's verb (the dictionary key), when it has one. */
export const eventVerbSource = (type: string): string | undefined => VERBS[type];

/** The translated verb a sentence about the event starts with ("Edited" "x");
 *  the event's readable name when there is none, never the code (eventTypeLabel). */
export function eventVerb(type: string): string {
  return VERBS[type] ? t(VERBS[type]) : eventTypeLabel(type);
}
