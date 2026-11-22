// "On another device" (history-replication batch 2): one rule for the author line of every history screen, and the flag travels from the server's rows
// to the paragraph history's entries.
import { afterEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../lib/i18n";
import { blockHistory, buildTimeline, historyAuthor, type BlockSourceVersion } from "../lib/history";

afterEach(() => setLocalePref("system"));

describe("the author line of a version made on another device", () => {
  it("adds the words after whoever wrote it, in English and Traditional Chinese, and only when asked", () => {
    setLocalePref("en");
    expect(historyAuthor("human", "Ann", "Me")).toEqual({ text: "Ann", tone: "member" });
    expect(historyAuthor("human", "Ann", "Me", true)).toEqual({ text: "Ann · on another device", tone: "member" });
    expect(historyAuthor("human", "Me", "Me", true).text).toBe("You · on another device");
    expect(historyAuthor("system", null, "Me", true)).toEqual({ text: "Automatic · on another device", tone: "system" });
    setLocalePref("zh-TW");
    expect(historyAuthor("human", "Ann", "Me", true).text).toBe("Ann・在另一台裝置上");
    expect(historyAuthor("session", null, "Me", true).text).toBe("臨時工作階段・在另一台裝置上");
  });

  it("the history screens' rows carry the server's flag: a note's timeline and a paragraph's entries", () => {
    const rows = [
      { id: "s:b:2:1", title: "T", markdown: "two", changed_at: "2026-09-02T08:00:00Z", actor_name: "Me", actor_type: "user" },
      { id: "s:a:7:1", title: "T", markdown: "one", changed_at: "2026-09-01T08:00:00Z", actor_name: "Me", actor_type: "user", on_another_device: true },
    ];
    const points = buildTimeline(rows, "two", "T");
    expect(points.map((p) => [p.versionId, p.onAnotherDevice])).toEqual([["s:a:7:1", true], ["s:b:2:1", false]]);
    const raw: BlockSourceVersion[] = rows.map(({ id, markdown, changed_at, actor_name, actor_type, ...rest }) => ({ id, markdown, changed_at, actor_name, actor_type, ...rest }));
    const entries = blockHistory(raw, { markdown: "two", offset: 1 });
    expect(entries.map((e) => [e.text, e.onAnotherDevice])).toEqual([["one", true], ["two", false]]);
  });
});
