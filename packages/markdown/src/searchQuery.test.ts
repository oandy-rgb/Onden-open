import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./searchQuery.js";

describe("parseSearchQuery — text only", () => {
  it("plain text passes through", () => {
    expect(parseSearchQuery("kafka streaming")).toEqual({
      text: "kafka streaming",
      tags: [],
      attrs: [],
    });
  });

  it("empty input → empty parsed", () => {
    expect(parseSearchQuery("")).toEqual({ text: "", tags: [], attrs: [] });
  });
});

describe("parseSearchQuery — tag tokens", () => {
  it("single tag", () => {
    expect(parseSearchQuery("#book")).toEqual({
      text: "",
      tags: ["book"],
      attrs: [],
    });
  });

  it("tag lowercased", () => {
    expect(parseSearchQuery("#Book")).toEqual({
      text: "",
      tags: ["book"],
      attrs: [],
    });
  });

  it("CJK + unicode tag names", () => {
    expect(parseSearchQuery("#技術筆記")).toEqual({
      text: "",
      tags: ["技術筆記"],
      attrs: [],
    });
  });

  it("text + tag composes", () => {
    expect(parseSearchQuery("kafka #book")).toEqual({
      text: "kafka",
      tags: ["book"],
      attrs: [],
    });
  });

  it("multiple tags", () => {
    expect(parseSearchQuery("#book #reading-log")).toEqual({
      text: "",
      tags: ["book", "reading-log"],
      attrs: [],
    });
  });
});

describe("parseSearchQuery — attribute tokens", () => {
  it("key:value attribute", () => {
    expect(parseSearchQuery("status:reading")).toEqual({
      text: "",
      tags: [],
      attrs: [{ key: "status", value: "reading" }],
    });
  });

  it("multiple attrs compose", () => {
    expect(parseSearchQuery("status:done priority:high")).toEqual({
      text: "",
      tags: [],
      attrs: [
        { key: "status", value: "done" },
        { key: "priority", value: "high" },
      ],
    });
  });

  it("quoted attribute value", () => {
    expect(parseSearchQuery('owner:"alice smith"')).toEqual({
      text: "",
      tags: [],
      attrs: [{ key: "owner", value: "alice smith" }],
    });
  });
});

// D44b: the key is the one attribute key grammar (@onden/markdown attributeKey.ts).
describe("parseSearchQuery — attribute keys in any script", () => {
  it("作者:王 is an attribute filter", () => {
    expect(parseSearchQuery("作者:王")).toEqual({ text: "", tags: [], attrs: [{ key: "作者", value: "王" }] });
  });

  it("CJK key with text, tag and a hyphenated key", () => {
    expect(parseSearchQuery("kafka #book 作者:王 reading-list:yes")).toEqual({
      text: "kafka",
      tags: ["book"],
      attrs: [{ key: "作者", value: "王" }, { key: "reading-list", value: "yes" }],
    });
  });

  it("a time stays text: a key starts with a letter or _", () => {
    expect(parseSearchQuery("12:30")).toEqual({ text: "12:30", tags: [], attrs: [] });
    expect(parseSearchQuery("-x:1")).toEqual({ text: "-x:1", tags: [], attrs: [] });
  });

  it("a URL stays text", () => {
    expect(parseSearchQuery("http://example.com https://例子.tw/a 作者://x")).toEqual({
      text: "http://example.com https://例子.tw/a 作者://x",
      tags: [],
      attrs: [],
    });
  });

  it("the first colon splits; the value keeps the rest", () => {
    expect(parseSearchQuery("時間:12:30")).toEqual({ text: "", tags: [], attrs: [{ key: "時間", value: "12:30" }] });
  });

  it("a full-width colon is text", () => {
    expect(parseSearchQuery("作者：王")).toEqual({ text: "作者：王", tags: [], attrs: [] });
  });
});

describe("parseSearchQuery — mixed", () => {
  it("text + tag + attribute", () => {
    expect(parseSearchQuery("kafka #book status:reading")).toEqual({
      text: "kafka",
      tags: ["book"],
      attrs: [{ key: "status", value: "reading" }],
    });
  });

  it("token order doesn't matter", () => {
    expect(parseSearchQuery("status:done #task kafka")).toEqual({
      text: "kafka",
      tags: ["task"],
      attrs: [{ key: "status", value: "done" }],
    });
  });

  it("multi-word text preserved", () => {
    expect(parseSearchQuery("event sourcing #book")).toEqual({
      text: "event sourcing",
      tags: ["book"],
      attrs: [],
    });
  });

  it("quoted text phrase", () => {
    expect(parseSearchQuery('"event sourcing" #book')).toEqual({
      text: '"event sourcing"',
      tags: ["book"],
      attrs: [],
    });
  });
});

describe("parseSearchQuery — malformed inputs degrade gracefully", () => {
  it("# alone is treated as text", () => {
    expect(parseSearchQuery("#")).toMatchObject({ tags: [] });
  });

  it("colon at start treated as text", () => {
    expect(parseSearchQuery(":value")).toMatchObject({ attrs: [] });
  });

  it("attribute with empty value treated as text", () => {
    expect(parseSearchQuery("status:")).toMatchObject({ attrs: [] });
  });
});

describe("parseSearchQuery — half-typed and regex-like input never throws", () => {
  it.each(['"abc', 'a:"b', "(", "[", "/(/", "\\", ".*+?^${}()|[]\\", "#(", "key:(", '""', "#a#b"])(
    "%s",
    (q) => {
      expect(() => parseSearchQuery(q)).not.toThrow();
    },
  );
});
