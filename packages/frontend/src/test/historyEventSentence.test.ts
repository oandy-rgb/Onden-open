import { describe, expect, it } from "vitest";
import { eventSentence, isMoveEvent } from "../lib/history/eventSentence";
import type { LiveEvent } from "../lib/liveEvent";

const titles = new Map([["n1", "書籤 新"], ["p1", "專案"]]);
const ctx = { titleOf: (id: string) => titles.get(id) };

function ev(over: Partial<LiveEvent>): LiveEvent {
  return {
    id: 1, actor_type: "user", actor_id: "u", event_type: "NODE_UPDATED", target_type: "node",
    target_id: "n1", payload: {}, created_at: "2026-10-22T01:55:00Z", ...over,
  };
}

describe("eventSentence", () => {
  it("names an edit by the note's current title", () => {
    expect(eventSentence(ev({}), ctx)).toBe("Edited 「書籤 新」");
  });
  it("prefers the title the event recorded (a renamed or deleted note)", () => {
    expect(eventSentence(ev({ payload: { title: "舊名" } }), ctx)).toBe("Edited 「舊名」");
    expect(eventSentence(ev({ event_type: "NODE_DELETED", target_id: "gone", payload: { title: "X" } }), ctx)).toBe("Deleted 「X」");
  });
  it("covers create, delete and restore", () => {
    expect(eventSentence(ev({ event_type: "NODE_CREATED", payload: { title: "X" } }), ctx)).toBe("Created 「X」");
    expect(eventSentence(ev({ event_type: "NODE_DELETED" }), ctx)).toBe("Deleted 「書籤 新」");
    expect(eventSentence(ev({ event_type: "NODE_UNDELETED" }), ctx)).toBe("Restored 「書籤 新」");
    expect(eventSentence(ev({ event_type: "NODE_RESTORED" }), ctx)).toBe("Restored 「書籤 新」");
  });
  it("says a note made (or stopped being) a review card in its own words, not as a tag's function", () => {
    const own = { target_id: "n1", tx_meta: { ui_context: "review.card" } };
    expect(eventSentence(ev({ ...own, event_type: "FUNCTION_REF_ADDED" }), ctx)).toBe("Made 「書籤 新」 a review card");
    expect(eventSentence(ev({ ...own, event_type: "FUNCTION_REF_REMOVED" }), ctx)).toBe("「書籤 新」 is no longer a review card");
    // An older event of a tag's function keeps its general name and never says "review card".
    expect(eventSentence(ev({ event_type: "FUNCTION_REF_ADDED", payload: { function_id: "review" } }), ctx)).not.toMatch(/review card/);
  });
  it("says a note's inherited place on the site in words, never by key", () => {
    const sentences = [
      eventSentence(ev({ event_type: "ATTRIBUTE_SET", payload: { key: "_published", value: "false", from_parent: "p1" } }), ctx),
      eventSentence(ev({ event_type: "ATTRIBUTE_SET", payload: { key: "_published_by_parent", value: "true", from_parent: "p1" } }), ctx),
      eventSentence(ev({ event_type: "ATTRIBUTE_DELETED", payload: { key: "_published_by_parent" } }), ctx),
    ];
    expect(sentences[0]).toBe("Kept 「書籤 新」 off the site, because the note above it is");
    for (const sentence of sentences) expect(sentence).not.toMatch(/_published/);
  });
  it("says a deck change in words, never by the attribute's name", () => {
    for (const event_type of ["ATTRIBUTE_SET", "ATTRIBUTE_DELETED"] as const) {
      const sentence = eventSentence(ev({ event_type, payload: { key: "slides_data" } }), ctx);
      expect(sentence).toBe("Changed the slides of 「書籤 新」");
      expect(sentence).not.toContain("slides_data");
    }
  });
  it("says Untitled for a note that is neither recorded nor loaded", () => {
    expect(eventSentence(ev({ target_id: "zzz" }), ctx)).toBe("Edited 「Untitled」");
  });
  it("reads a parent change as a move, naming the new parent", () => {
    const moved = ev({ payload: { parent_id: "p1" }, tx_meta: { prev_field_values: { parent_id: null } } });
    expect(isMoveEvent(moved)).toBe(true);
    expect(eventSentence(moved, ctx)).toBe("Moved 「書籤 新」 into 「專案」");
    const toRoot = ev({ payload: { parent_id: null }, tx_meta: { prev_field_values: { parent_id: "p1" } } });
    expect(eventSentence(toRoot, ctx)).toBe("Moved 「書籤 新」 to the top level");
    const unknownParent = ev({ payload: { parent_id: "nope" }, tx_meta: { prev_field_values: { parent_id: null } } });
    expect(eventSentence(unknownParent, ctx)).toBe("Moved 「書籤 新」");
  });
  it("does not call a save that repeats the parent a move", () => {
    const same = ev({ payload: { parent_id: "p1" }, tx_meta: { prev_field_values: { parent_id: "p1" } } });
    expect(isMoveEvent(same)).toBe(false);
    expect(eventSentence(same, ctx)).toBe("Edited 「書籤 新」");
    expect(isMoveEvent(ev({ payload: { parent_id: "p1" } }))).toBe(false); // no recorded previous value
  });
  it("describes tags and fields", () => {
    expect(eventSentence(ev({ event_type: "TAG_APPLIED", payload: { tag_name: "工作" } }), ctx)).toBe("Tagged 「書籤 新」 with #工作");
    expect(eventSentence(ev({ event_type: "TAG_REMOVED", payload: { tag_name: "工作" } }), ctx)).toBe("Removed #工作 from 「書籤 新」");
    expect(eventSentence(ev({ event_type: "ATTRIBUTE_SET", payload: { key: "status" } }), ctx)).toBe("Set status on 「書籤 新」");
    expect(eventSentence(ev({ event_type: "ATTRIBUTE_DELETED", payload: { key: "status" } }), ctx)).toBe("Cleared status on 「書籤 新」");
  });
  it("falls back to the type name in words (never the code) for an event it has no sentence for", () => {
    expect(eventSentence(ev({ event_type: "TAG_APPLIED" }), ctx)).toBe("tag applied 「書籤 新」"); // no tag name recorded
    expect(eventSentence(ev({ event_type: "SITE_PUBLISHED", target_type: "site", target_id: "s" }), ctx)).toBe("site published");
  });
  it("counts a purge", () => {
    expect(eventSentence(ev({ event_type: "NODES_PURGED", payload: { count: 3 } }), ctx)).toBe("3 note(s) deleted for good");
  });
});
