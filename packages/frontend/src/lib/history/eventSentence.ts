// One readable sentence per history event ("編輯了「書籤 新」"), built from the
// event's type and payload. The event log's compact rows and their grouped
// form use it; the raw type name stays in the row's expanded details.
import { KEPT_OFF_BY_PARENT_ATTR_KEY, PUBLISHED_ATTR_KEY, SLIDES_DATA_ATTR } from "@onden/markdown";
import { t } from "../i18n";
import { eventTypeLabel } from "../eventKinds";
import type { LiveEvent } from "../liveEvent";
import { agentName, agentToolSentence, isAgentToolEvent } from "./agentCalls";
import { untitledTitle } from "../noteLabel";

export type SentenceContext = {
  /** Title of a live note by id; undefined when it is unknown or gone. */
  titleOf: (id: string) => string | undefined;
  /** An AI agent's display name by actor id; undefined when unknown. */
  agentNameOf?: (actorId: string) => string | undefined;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The note an event is about: the title the event recorded, else the live
 *  note's title, else "Untitled" for a note and null for other targets. */
export function eventSubjectTitle(e: LiveEvent, ctx: SentenceContext): string | null {
  const recorded = str(e.payload?.title);
  if (recorded) return recorded;
  if (e.target_type !== "node") return null;
  return ctx.titleOf(e.target_id) ?? untitledTitle();
}

/** True when a NODE_UPDATED event changed the note's parent: the payload names
 *  the new parent and the recorded previous value differs. A save that merely
 *  repeats the parent is an edit. */
export function isMoveEvent(e: LiveEvent): boolean {
  if (e.event_type !== "NODE_UPDATED" || !e.payload || !("parent_id" in e.payload)) return false;
  const prev = e.tx_meta?.prev_field_values as Record<string, unknown> | undefined;
  if (!prev || !("parent_id" in prev)) return false;
  return (prev.parent_id ?? null) !== (e.payload.parent_id ?? null);
}

/** The event as a sentence; an AI agent's change names the agent first
 *  ("AI 編輯了「X」"). */
export function eventSentence(e: LiveEvent, ctx: SentenceContext): string {
  if (isAgentToolEvent(e)) return agentToolSentence(e, ctx);
  const sentence = changeSentence(e, ctx);
  if (e.actor_type !== "ai_agent") return sentence;
  return `${agentName(e, ctx)} ${sentence.replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
}

/** Unknown event types fall back to their readable name plus the note, so a
 *  new server event still shows something. */
function changeSentence(e: LiveEvent, ctx: SentenceContext): string {
  const p = e.payload ?? {};
  const title = eventSubjectTitle(e, ctx);
  const quoted = title === null ? null : `「${title}」`;
  const tag = str(p.tag_name) ? `#${str(p.tag_name)}` : "";

  if (e.event_type === "NODES_PURGED" && typeof p.count === "number") {
    return t("{n} note(s) deleted for good", { n: p.count });
  }
  if (isMoveEvent(e)) {
    const parentId = str(p.parent_id);
    if (!parentId) return t("Moved {title} to the top level", { title: quoted ?? "" });
    const parent = ctx.titleOf(parentId);
    return parent
      ? t("Moved {title} into {parent}", { title: quoted ?? "", parent: `「${parent}」` })
      : t("Moved {title}", { title: quoted ?? "" });
  }
  if (quoted !== null) {
    // The text boxes on a page (page_text): said in words, never by key.
    if ((e.event_type === "ATTRIBUTE_SET" || e.event_type === "ATTRIBUTE_DELETED") && p.key === "page_text") {
      return t("Changed the text on the pages of {title}", { title: quoted });
    }
    // The deck's chosen layouts and theme (slides_data): the same.
    if ((e.event_type === "ATTRIBUTE_SET" || e.event_type === "ATTRIBUTE_DELETED") && p.key === SLIDES_DATA_ATTR) {
      return t("Changed the slides of {title}", { title: quoted });
    }
    // The pictures on a page (page_images): the same.
    if ((e.event_type === "ATTRIBUTE_SET" || e.event_type === "ATTRIBUTE_DELETED") && p.key === "page_images") {
      return t("Changed the pictures on the pages of {title}", { title: quoted });
    }
    // The note's place on the site: never by key. Made under a note kept off the site, it starts off too (backend siteDefault.ts).
    if (e.event_type === "ATTRIBUTE_SET" && p.key === KEPT_OFF_BY_PARENT_ATTR_KEY) return t("Noted why {title} is kept off the site", { title: quoted });
    if (e.event_type === "ATTRIBUTE_DELETED" && p.key === KEPT_OFF_BY_PARENT_ATTR_KEY) return t("Cleared the reason {title} was kept off the site", { title: quoted });
    if (e.event_type === "ATTRIBUTE_SET" && p.key === PUBLISHED_ATTR_KEY && str(p.from_parent)) return t("Kept {title} off the site, because the note above it is", { title: quoted });
    switch (e.event_type) {
      case "NODE_CREATED": return t("Created {title}", { title: quoted });
      case "NODE_UPDATED": return t("Edited {title}", { title: quoted });
      case "NODE_DELETED": return t("Deleted {title}", { title: quoted });
      case "NODE_RESTORED":
      case "NODE_UNDELETED": return t("Restored {title}", { title: quoted });
      // A note made a review card itself by its command (ui_context review.card), not a tag's function (older events on tags).
      case "FUNCTION_REF_ADDED": if (e.tx_meta?.ui_context === "review.card") return t("Made {title} a review card", { title: quoted }); break;
      case "FUNCTION_REF_REMOVED": if (e.tx_meta?.ui_context === "review.card") return t("{title} is no longer a review card", { title: quoted }); break;
      case "TAG_APPLIED": if (tag) return t("Tagged {title} with {tag}", { title: quoted, tag }); break;
      case "TAG_REMOVED": if (tag) return t("Removed {tag} from {title}", { title: quoted, tag }); break;
      case "ATTRIBUTE_SET": if (str(p.key)) return t("Set {key} on {title}", { key: String(p.key), title: quoted }); break;
      case "ATTRIBUTE_DELETED": if (str(p.key)) return t("Cleared {key} on {title}", { key: String(p.key), title: quoted }); break;
    }
    return `${eventTypeLabel(e.event_type)} ${quoted}`;
  }
  return eventTypeLabel(e.event_type);
}
