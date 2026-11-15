// Read-later (migration 192) and citations (migration 193) were removed; the history they left must still read in plain words:
// no function id, module id or event constant reaches the screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventSentence } from "../lib/history/eventSentence";
import { eventTypeLabel } from "../lib/eventKinds";
import { setLocalePref } from "../lib/i18n";
import type { LiveEvent } from "../lib/liveEvent";

const ev = (over: Partial<LiveEvent>): LiveEvent => ({
  id: 1, actor_type: "user", actor_id: "u", event_type: "FUNCTION_REF_ADDED", target_type: "tag", target_id: "t1",
  payload: {}, created_at: "2026-10-22T01:55:00Z", ...over,
});
const ctx = { titleOf: (id: string) => (id === "t1" ? "稍後讀" : undefined) };

const OLD_EVENTS: LiveEvent[] = [
  ev({ event_type: "FUNCTION_REF_ADDED", payload: { function_id: "read_later" } }),
  ev({ event_type: "FUNCTION_REF_REMOVED", payload: { function_id: "read_later" } }),
  ev({ event_type: "MODULE_IMPORTED", target_type: "workspace", payload: { module: "read_later" } }),
  ev({ event_type: "MODULE_REMOVED", target_type: "workspace", payload: { module: "read_later" } }),
  ev({ event_type: "TAG_MODULES_MIGRATED", payload: { migration: "192_remove_read_later" } }),
];

// Events written while the citations module existed, and the one migration 193 writes for the tags it changed.
const OLD_CITATION_EVENTS: LiveEvent[] = [
  ev({ event_type: "FUNCTION_REF_ADDED", payload: { function_id: "citations" } }),
  ev({ event_type: "FUNCTION_REF_REMOVED", payload: { function_id: "citations" } }),
  ev({ event_type: "MODULE_IMPORTED", target_type: "workspace", payload: { module: "citations" } }),
  ev({ event_type: "MODULE_REMOVED", target_type: "workspace", payload: { module: "citations" } }),
  ev({ event_type: "TAG_MODULES_MIGRATED", payload: { migration: "193_remove_citations_module" } }),
];

describe("history of the removed read-later feature", () => {
  beforeEach(() => setLocalePref("zh-TW"));
  afterEach(() => setLocalePref("en"));

  it("every old event still has a plain label, in Chinese and in English", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      setLocalePref(locale);
      for (const event of OLD_EVENTS) {
        const label = eventTypeLabel(event.event_type);
        expect(label, event.event_type).not.toMatch(/[A-Z]{3,}|_/);
        if (locale === "zh-TW") expect(label, event.event_type).toMatch(/[一-鿿]/);
      }
    }
  });

  it("an old event's sentence never shows the retired ids", () => {
    for (const event of OLD_EVENTS) {
      const sentence = eventSentence(event, ctx);
      expect(sentence, event.event_type).not.toMatch(/read_later|192_|[A-Z]{3,}_[A-Z]/);
    }
  });
});

describe("history of the removed citations feature", () => {
  beforeEach(() => setLocalePref("zh-TW"));
  afterEach(() => setLocalePref("en"));

  it("an old event's sentence never shows the retired ids, in Chinese and in English", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      setLocalePref(locale);
      for (const event of OLD_CITATION_EVENTS) {
        const sentence = eventSentence(event, ctx);
        expect(sentence, `${locale} ${event.event_type}`).not.toMatch(/citations|193_|[A-Z]{3,}_[A-Z]/);
        expect(eventTypeLabel(event.event_type), event.event_type).not.toMatch(/[A-Z]{3,}|_/);
      }
    }
  });
});
