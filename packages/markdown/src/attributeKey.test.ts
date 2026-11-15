import { describe, expect, it } from "vitest";
import { attributeLines, entryFor, entryValue, isAttributeKey, isSettableAttributeKey, readFrontmatter, writeFrontmatter } from "./index.js";

// One key alphabet for the UI, the API and both text grammars (depth audit
// D44): a key the app accepts is a key frontmatter and `key::` read back.
describe("attribute key grammar", () => {
  it("letters (any script), digits, _ and -, starting with a letter or _", () => {
    for (const key of ["status", "作者", "締め切り", "작가", "Ünïcode", "_published", "due_date", "due-date", "v2"]) {
      expect(isAttributeKey(key), key).toBe(true);
    }
    for (const key of ["", "due date", "a:b", "2024", "-x", "#tag", "a.b", "a/b", "a]", "k\n", " status", "😀"]) {
      expect(isAttributeKey(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("every key the grammar accepts reads back from frontmatter and from key:: lines", () => {
    for (const key of ["status", "作者", "締め切り", "_x", "a-b_c"]) {
      const front = readFrontmatter(writeFrontmatter([entryFor(key, "王")]) + "Body")!;
      expect(front.entries.map((e) => [e.key, entryValue(e)])).toEqual([[key, "王"]]);
      expect(attributeLines(`${key}:: 王\nSee [${key}:: 李]`).map((a) => [a.form, a.key, a.value]))
        .toEqual([["line", key, "王"], ["bracket", key, "李"]]);
    }
  });

  it("a key a person may add: an attribute key, or child: + one", () => {
    expect(["status", "作者", "child:status", "child:作者"].map(isSettableAttributeKey)).toEqual([true, true, true, true]);
    expect(["child:", "child:due date", "a:b", "child: x"].map(isSettableAttributeKey)).toEqual([false, false, false, false]);
  });

  it("entryFor quotes a key outside the grammar so the line reads back as that key", () => {
    for (const key of ["due date", "a: b", "#x", "2024", 'say "hi"', "line\nbreak"]) {
      const block = writeFrontmatter([entryFor(key, "v"), entryFor(key + "2", ["a", "b"])]);
      const entries = readFrontmatter(`${block}Body`)!.entries;
      expect(entries.map((e) => e.key), key).toEqual([key, key + "2"]);
      expect(entryValue(entries[0]!), key).toBe("v");
      expect(entryValue(entries[1]!), key).toEqual(["a", "b"]);
    }
    expect(() => entryFor("", "v")).toThrow(/frontmatter key/);
  });

  it("a multi-line value is one quoted line and reads back whole", () => {
    const entry = entryFor("notes", "one\ntwo: \"x\"\n");
    expect(entry.lines).toHaveLength(1);
    expect(entryValue(readFrontmatter(`${writeFrontmatter([entry])}b`)!.entries[0]!)).toBe("one\ntwo: \"x\"\n");
  });

  it("an Obsidian note's CJK properties and inline fields are attributes", () => {
    const note = "---\n作者: 王小明\n標籤:\n  - 讀書\n  - 筆記\n---\n評分:: 5\n讀到 [頁數:: 120] 頁";
    const front = readFrontmatter(note)!;
    expect(front.entries.map((e) => [e.key, entryValue(e)])).toEqual([["作者", "王小明"], ["標籤", ["讀書", "筆記"]]]);
    expect(attributeLines(front.body).map((a) => [a.key, a.value])).toEqual([["評分", "5"], ["頁數", "120"]]);
  });

  it("a list item that is a CJK map entry is a list of maps, not a list of scalars", () => {
    expect(entryValue(readFrontmatter("---\n連結:\n  - 網址: a\n---\n")!.entries[0]!)).toBeUndefined();
  });

  it("keys outside the grammar stay verbatim lines without a key", () => {
    const front = readFrontmatter("---\ndue date: 2026-10-17\n---\n")!;
    expect(front.entries).toEqual([{ key: null, lines: ["due date: 2026-10-17"] }]);
    expect(attributeLines("due date:: x\n[due date:: y]")).toEqual([]);
  });
});
