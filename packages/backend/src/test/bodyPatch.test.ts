// Unit tests for the body-patch utilities (ER2).
//
// The round-trip identity (rebuildPreEventBody(newBody, makeInversePatch(old,
// new)) === oldBody) is the load-bearing property; everything else is
// covering edge cases (empty bodies, CRLF, unicode, large bodies, divergent
// current state).

import { describe, it, expect } from "vitest";
import {
  makeInversePatch,
  rebuildPreEventBody,
  rebuildFromUnchangedBody,
} from "../services/eventLog/bodyPatch.js";

describe("bodyPatch", () => {
  describe("makeInversePatch + rebuildPreEventBody round trip", () => {
    it("identity: same body in and out produces an empty patch", () => {
      const body = "# heading\n\nbody text\n";
      const patch = makeInversePatch(body, body);
      expect(patch).toBe("");
      expect(rebuildPreEventBody(body, patch)).toBe(body);
    });

    it("simple line insertion: revert recovers old body exactly", () => {
      const oldBody = "line one\nline two\nline three\n";
      const newBody = "line one\nline two\nline two-and-a-half\nline three\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("simple line deletion: revert recovers old body exactly", () => {
      const oldBody = "line one\nline two\nline three\n";
      const newBody = "line one\nline three\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("char-level substitution: revert recovers old body exactly", () => {
      const oldBody = "The quick brown fox jumps.";
      const newBody = "The quick brown fox leaps.";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("empty → content: revert removes everything", () => {
      const oldBody = "";
      const newBody = "freshly written paragraph\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe("");
    });

    it("content → empty: revert recovers the deleted body", () => {
      const oldBody = "this got deleted by accident\nmultiple lines\n";
      const newBody = "";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("CRLF line endings preserved on revert", () => {
      const oldBody = "windows file\r\nwith CRLF\r\n";
      const newBody = "windows file\r\nwith CRLF\r\nplus another line\r\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("unicode (CJK + emoji) preserved on revert", () => {
      const oldBody = "中文筆記 with 🎉 emoji\n";
      const newBody = "中文筆記 — 加了一些字 with 🎉🎊 emoji\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });

    it("markdown frontmatter + body change: revert exact", () => {
      const oldBody = "---\ntitle: foo\nstatus: draft\n---\n\nhello world\n";
      const newBody = "---\ntitle: foo bar\nstatus: reviewed\n---\n\nhello world\nadded line\n";
      const patch = makeInversePatch(oldBody, newBody);
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });
  });

  describe("storage efficiency vs prev_body snapshot", () => {
    it("100KB body with a single 1-line change produces a small patch", () => {
      // 100 KB of repeated paragraphs
      const base = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n".repeat(2000);
      const oldBody = base;
      const newBody = base.replace("Lorem ipsum", "LOREM IPSUM");
      const patch = makeInversePatch(oldBody, newBody);
      const patchBytes = Buffer.byteLength(patch, "utf8");
      const bodyBytes = Buffer.byteLength(newBody, "utf8");
      // Patch should be far smaller than the body — the savings argument
      // documented in bodyPatch.ts. We assert <5% which is a soft bound;
      // typical incremental edits land well under 1%.
      expect(patchBytes / bodyBytes).toBeLessThan(0.05);
      // And of course the round trip still works
      expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
    });
  });

  describe("rebuildPreEventBody", () => {
    it("rebuilds the pre-event body from the event's own post body", () => {
      const oldBody = "the original line\n";
      const newBody = "the original line\nplus a new line\n";
      expect(rebuildPreEventBody(newBody, makeInversePatch(oldBody, newBody))).toBe(oldBody);
    });

    it("an empty patch is the identity on any body", () => {
      expect(rebuildPreEventBody("anything\nat\nall\n", "")).toBe("anything\nat\nall\n");
    });

    it("returns null when a hunk does not apply", () => {
      const patch = makeInversePatch("original line one\noriginal line two\n", "original line one\nedited line two\n");
      expect(rebuildPreEventBody("completely\ndifferent\nbody\nentirely\n", patch)).toBeNull();
    });
  });

  // D79: patch_apply on a body someone edited since the event reports every
  // hunk applied when the context still matches, and lands over their edit.
  // Without the post body, only an unchanged body may be reverted.
  describe("rebuildFromUnchangedBody (events with no post blob)", () => {
    const pre = "Shopping list:\n- 買牛奶 today\n- eggs\n";
    const post = "Shopping list:\n- 買豆漿 today\n- eggs\n";
    const patch = makeInversePatch(pre, post);

    it("reverts the body the event left", () => {
      expect(rebuildFromUnchangedBody(post, patch)).toBe(pre);
    });

    it("refuses a body another writer changed since, where patch_apply would overwrite them", () => {
      const later = "Shopping list:\n- 買咖啡 today\n- eggs\n";
      expect(rebuildFromUnchangedBody(later, patch)).toBeNull();
      // An edit before the hunk moves it: also refused, not searched for.
      expect(rebuildFromUnchangedBody(`# 今天\n${post}`, patch)).toBeNull();
    });

    it("the patch only sees its own hunks: an edit past them is kept", () => {
      expect(rebuildFromUnchangedBody(`${post}- bread\n`, patch)).toBe(`${pre}- bread\n`);
    });
  });
});
