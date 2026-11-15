import { describe, it, expect } from "vitest";
import type { Space } from "../../lib/spaces";
import { publishBlocker, siteStanding } from "./publishBlocker";

const space = (id: string, publish: boolean): Space =>
  ({ id, name: id, kind: "shared", is_default: false, owner_actor_id: null, capabilities: { publish }, permission: "edit", can_manage: false });
const spaces = [space("site", true), space("team", false)];

describe("publishBlocker (the server's publishedNodeIds, as far as the client sees)", () => {
  it("a visible note in a publishing space is not blocked", () => {
    expect(publishBlocker({ space_id: "site" }, spaces)).toBeNull();
  });

  it("a hidden note is blocked, whatever its space", () => {
    expect(publishBlocker({ hidden: true, space_id: "site" }, spaces)).toEqual({ reason: "hidden" });
    expect(publishBlocker({ hidden: true, space_id: "team" }, spaces)).toEqual({ reason: "hidden" });
  });

  it("a space that doesn't allow publishing blocks; an unknown space does not", () => {
    expect(publishBlocker({ space_id: "team" }, spaces)).toEqual({ reason: "space", space: "team" });
    expect(publishBlocker({ space_id: "elsewhere" }, spaces)).toBeNull();
    expect(publishBlocker({ space_id: "team" }, [])).toBeNull();
  });
});

describe("siteStanding (whether the site would show a note: by space, with the note's own say)", () => {
  const words = { id: "n", space_id: "site", source_type: "manual" as const, markdown: "Words.", attrs: {} };
  it("a note with words in a publishing space is on, with no mark", () => {
    expect(siteStanding(words, spaces, false)).toEqual({ on: true });
  });
  it("「不發布」 keeps it off, whatever else holds; 「發布」 brings a blank note or a saved article on", () => {
    expect(siteStanding({ ...words, attrs: { _published: "false" } }, spaces, false)).toEqual({ on: false, reason: "kept_off" });
    expect(siteStanding({ ...words, markdown: "", attrs: { _published: "true" } }, spaces, false)).toEqual({ on: true });
    expect(siteStanding({ ...words, source_type: "rss", attrs: { _published: "true" } }, spaces, false)).toEqual({ on: true });
  });
  it("a blank note and an article saved from a feed stay off by default", () => {
    expect(siteStanding({ ...words, markdown: " \n" }, spaces, false)).toEqual({ on: false, reason: "blank" });
    expect(siteStanding({ ...words, source_type: "rss" }, spaces, false)).toEqual({ on: false, reason: "saved_article" });
  });
  it("blank is the server's rule on the loaded text (Postgres whitespace), whatever body_len says", () => {
    // body_len counts the characters, so a note of only a space has body_len 1 and is still blank.
    for (const space of [" ", "\n", "\t", "\r\n \t", "\u2003", "\u3000", "\u2009 \n\u3000"]) {
      expect(siteStanding({ ...words, markdown: space, body_len: space.length }, spaces, false)).toEqual({ on: false, reason: "blank" });
    }
    // Postgres' \S treats a no-break space, a zero-width space and the BOM as text, so the site shows these notes.
    for (const text of ["\u00a0", "\u202f", "\u2007", "\u200b", "\ufeff", " \u00a0 "]) {
      expect(siteStanding({ ...words, markdown: text, body_len: text.length }, spaces, false)).toEqual({ on: true });
    }
  });
  it("a note with no words is not blank when its body is not loaded yet, a note sits under it, or it keeps something beside the text", () => {
    expect(siteStanding({ ...words, markdown: "", body_len: 12 }, spaces, false)).toEqual({ on: true });
    expect(siteStanding({ ...words, markdown: "" }, spaces, true)).toEqual({ on: true });
    expect(siteStanding({ ...words, markdown: "", attrs: { ink_data: "{}" } }, spaces, false)).toEqual({ on: true });
  });
  it("a hidden note or a space that does not publish keeps it off, even when marked", () => {
    expect(siteStanding({ ...words, hidden: true, attrs: { _published: "true" } }, spaces, false)).toEqual({ on: false, reason: "hidden" });
    expect(siteStanding({ ...words, space_id: "team", attrs: { _published: "true" } }, spaces, false)).toEqual({ on: false, reason: "space" });
  });
});
