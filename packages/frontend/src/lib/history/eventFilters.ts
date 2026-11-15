// The event log's filters as one value, so the phone sheet, the removable chips
// and the query all read the same state.
import { eventTypeLabel } from "../eventKinds";
import { t } from "../i18n";

export type ActorFilter = "" | "user" | "ai_agent" | "system";

export type EventFilters = {
  actor: ActorFilter;
  /** An event type code; "" for all. Ignored while `deletedOnly`. */
  type: string;
  /** History's Deleted-notes view. */
  deletedOnly: boolean;
};

export const NO_FILTERS: EventFilters = { actor: "", type: "", deletedOnly: false };

export type ActiveFilter = { key: "deleted" | "actor" | "type"; label: string };

const ACTOR_LABELS: Record<Exclude<ActorFilter, "">, string> = {
  user: "User", ai_agent: "AI", system: "System (automatic)",
};

/** The filters that are set, in display order, each with the chip text.
 *  The type filter is not active (nor shown) in the Deleted view, which has none. */
export function activeFilters(f: EventFilters): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (f.deletedOnly) out.push({ key: "deleted", label: t("Deleted notes") });
  if (f.actor) out.push({ key: "actor", label: t(ACTOR_LABELS[f.actor]) });
  if (f.type && !f.deletedOnly) out.push({ key: "type", label: eventTypeLabel(f.type) });
  return out;
}

/** The filters without one chip's filter. */
export function clearFilter(f: EventFilters, key: ActiveFilter["key"]): EventFilters {
  if (key === "deleted") return { ...f, deletedOnly: false };
  if (key === "actor") return { ...f, actor: "" };
  return { ...f, type: "" };
}
