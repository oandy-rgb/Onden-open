import { sendWrite } from "./onlineWrite";
import { sendOrQueue } from "./writeQueue";

// What a person does to RSS feeds and their items. Online only; callers report failures through writeErrors.
// (Subscribing, saving an item and marking one seen go through sendOrQueue: they survive going offline.)
export const rssWriter = {
  unsubscribe: (sourceId: string) => sendWrite("POST", `/api/rss/sources/${sourceId}/unsubscribe`, {}),
  /** Change one or more settings of a feed; the server answers with the feed's new values. */
  changeSource: <T>(sourceId: string, body: Record<string, unknown>) => sendWrite<T>("PATCH", `/api/rss/sources/${sourceId}`, body),
  refreshSource: (sourceId: string) => sendWrite("POST", `/api/rss/sources/${sourceId}/refresh`, "{}"),
  /** Seen is idempotent, so it rides the offline queue; a refusal (4xx) rejects, the caller shows the item unseen again. */
  markSeen: (itemId: string) => sendOrQueue("POST", `/api/rss/items/${itemId}/seen`, "{}"),
  fetchFullText: (itemId: string) => sendWrite<{ body?: string }>("POST", `/api/rss/items/${itemId}/fulltext`, "{}"),
  importOpml: (opml: string) => sendWrite<{ imported: number; skipped: number }>("POST", "/api/rss/opml", { opml }),
  /** Answers the mute's id (to take it back). */
  muteFeed: (sourceId: string) => sendWrite<{ id: string }>("POST", "/api/rss/mutes", { source_id: sourceId }),
  unmute: (muteId: string) => sendWrite("DELETE", `/api/rss/mutes/${muteId}`),
};
