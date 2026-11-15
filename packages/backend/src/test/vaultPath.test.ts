// D109: one rule for where a note lives in a Markdown vault — the zip export
// writes it, the folder import reads it back (services/vaultPath.ts).

import { describe, expect, it } from "vitest";
import { folderDepth, folderNoteFile, parentFolderOf, vaultPaths } from "../services/vaultPath.js";
import { backupEntryKind } from "../services/backupFile.js";

// `name` is the note's title (a file is named by it); the slug is a different spelling.
const n = (id: string, name: string | null, parent_id: string | null = null) => ({ id, title: name ?? "", slug: !name?.trim() ? null : `s-${name}`, parent_id });

describe("vaultPaths: a generated file name is unique across the space", () => {
  it("skips ` 2` when another folder's note is titled that", () => {
    const paths = vaultPaths([n("a", "Meeting"), n("b", "Meeting"), n("p", "P"), n("c", "Meeting 2", "p")]);
    expect(paths.get("c")).toBe("P/Meeting 2");
    expect(paths.get("b")).toBe("Meeting 3");
  });

  it("skips a name that is another note's alias, and one another note already generated", () => {
    const paths = vaultPaths([
      { ...n("a", "X"), aliases: ["Foo 2"] }, n("b", "Foo"), n("c", "Foo"), n("d", "Foo"), n("p", "P"),
    ]);
    // Foo (b) keeps its title; c would be `Foo 2` (alias of a) → `Foo 3`; d → `Foo 4`.
    expect([paths.get("b"), paths.get("c"), paths.get("d")]).toEqual(["Foo", "Foo 3", "Foo 4"]);
  });

  it("a note keeps the file name it already holds as its own alias (a second export is the same)", () => {
    const paths = vaultPaths([{ ...n("a", "A: B"), aliases: ["A B"] }]);
    expect(paths.get("a")).toBe("A B");
  });

  it("a cleaned name that equals another title gets a number instead", () => {
    const paths = vaultPaths([n("a", "A: B"), n("b", "A B")]);
    expect(paths.get("b")).toBe("A B");
    expect(paths.get("a")).toBe("A B 2");
  });
});

describe("vaultPaths (D109)", () => {
  it("puts a child in its parent's folder, the parent's own file beside it", () => {
    const paths = vaultPaths([n("a", "課程"), n("b", "演算法", "a"), n("c", "排序", "b")]);
    expect(Object.fromEntries(paths)).toEqual({ a: "課程", b: "課程/演算法", c: "課程/演算法/排序" });
    // What the importer looks for: the folder's note is the file beside it.
    expect(folderNoteFile(parentFolderOf(`${paths.get("b")}.md`)!)).toBe(`${paths.get("a")}.md`);
  });

  it("does not depend on the order parents and children come in", () => {
    const paths = vaultPaths([n("c", "排序", "b"), n("b", "演算法", "a"), n("a", "課程")]);
    expect(paths.get("c")).toBe("課程/演算法/排序");
  });

  it("puts a note whose parent is not exported at the root", () => {
    expect(vaultPaths([n("b", "child", "hidden-parent")]).get("b")).toBe("child");
  });

  it("keeps names unique per folder, ignoring case; the first keeps the name and its folder", () => {
    const paths = vaultPaths([
      n("11111111-aaaa", "notes"), n("22222222-bbbb", "Notes"), n("33333333-cccc", "x", "22222222-bbbb"),
      n("44444444-dddd", "notes", "11111111-aaaa"),
    ]);
    expect(paths.get("11111111-aaaa")).toBe("notes");
    expect(paths.get("22222222-bbbb")).toBe("Notes 2");
    // A folder takes its note's final name.
    expect(paths.get("33333333-cccc")).toBe("Notes 2/x");
    // The same name in another folder is no clash.
    expect(paths.get("44444444-dddd")).toBe("notes/notes");
  });

  it("finds a free name even when the suffixed one is taken", () => {
    const paths = vaultPaths([n("i1", "a"), n("x", "a 2"), n("i2", "a"), n("i3", "A")]);
    expect(new Set([...paths.values()].map((p) => p.toLowerCase())).size).toBe(4);
    expect(paths.get("i2")).toBe("a 3");
    expect(paths.get("i3")).toBe("A 4");
  });

  it("cuts a parent cycle instead of hanging, and every note still gets a path", () => {
    const paths = vaultPaths([n("a", "a", "c"), n("b", "b", "a"), n("c", "c", "b"), n("self", "self", "self")]);
    expect(paths.size).toBe(4);
    expect(paths.get("self")).toBe("self");
    // One of the cycle is at the root; the others hang under it.
    const roots = ["a", "b", "c"].filter((id) => !paths.get(id)!.includes("/"));
    expect(roots).toHaveLength(1);
    expect(["a", "b", "c"].map((id) => paths.get(id)!.split("/").length).sort()).toEqual([1, 2, 3]);
  });

  it("uses the id for a missing slug and keeps a slug inside its folder", () => {
    const paths = vaultPaths([n("id-1", null), n("id-2", "  "), n("id-3", "a/../b"), n("id-4", ".trash"), n("id-5", "..")]);
    expect(paths.get("id-1")).toBe("id-1");
    expect(paths.get("id-2")).toBe("id-2");
    expect(paths.get("id-3")).toBe("a .. b");
    // No hidden file, and never the .trash/ or .onden/ a backup reserves.
    expect(paths.get("id-4")).toBe("trash");
    expect(paths.get("id-5")).toBe("s-"); // title "..", then the slug
  });

  it("names a file by the title; a title a file name cannot hold is cleaned, not dropped", () => {
    const paths = vaultPaths([
      { id: "a", title: "歡迎來到 Onden 試用版", slug: "huan-ying", parent_id: null },
      { id: "b", title: "讀書筆記：作業系統", slug: "du-shu", parent_id: null },
      { id: "g", title: "Chapter 1: Intro", slug: "chapter-1", parent_id: null },
      { id: "c", title: "What is *this*? <a|b> \"q\"", slug: "what", parent_id: null },
      { id: "d", title: "CON", slug: "con", parent_id: null },
      { id: "e", title: "   ", slug: "fallback slug", parent_id: null },
      { id: "f", title: "a [[b]] #c ^d", slug: null, parent_id: null },
    ]);
    expect(paths.get("a")).toBe("歡迎來到 Onden 試用版");
    expect(paths.get("b")).toBe("讀書筆記：作業系統"); // a full-width colon is a legal name
    expect(paths.get("g")).toBe("Chapter 1 Intro");
    expect(paths.get("c")).toBe("What is this a b q");
    expect(paths.get("d")).toBe("CON note");
    expect(paths.get("e")).toBe("fallback slug");
    expect(paths.get("f")).toBe("a b c d");
  });

  it("parentFolderOf, folderNoteFile and folderDepth read a path the same way", () => {
    expect(parentFolderOf("a.md")).toBeNull();
    expect(parentFolderOf("課程/演算法.md")).toBe("課程");
    expect(folderNoteFile("課程/演算法")).toBe("課程/演算法.md");
    expect(folderDepth("a.md")).toBe(0);
    expect(folderDepth("a/b/c.md")).toBe(2);
  });
});

describe("a backup's vault half may be nested (D109)", () => {
  it("accepts nested note files and the older flat layout", () => {
    expect(backupEntryKind("課程.md")).toBe("markdown");
    expect(backupEntryKind("課程/演算法.md")).toBe("markdown");
    expect(backupEntryKind("課程/演算法/排序.md")).toBe("markdown");
    expect(backupEntryKind(".trash/old.md")).toBe("markdown");
  });

  it("still refuses traversal, dot folders and anything that is not a note", () => {
    expect(backupEntryKind("../x.md")).toBeNull();
    expect(backupEntryKind("a/../x.md")).toBeNull();
    expect(backupEntryKind(".onden/x.md")).toBeNull();
    expect(backupEntryKind("a/.hidden/x.md")).toBeNull();
    expect(backupEntryKind(".trash/a/x.md")).toBeNull();
    expect(backupEntryKind("a\\b.md")).toBeNull();
    expect(backupEntryKind("a/b.txt")).toBeNull();
  });
});
