// D9 PRIVACY: a published page's [[wikilink]] to an unpublished/private node
// must NOT leak that node's title into the static output. These pin the
// inert-link redaction at its source — the same functions the snapshot builder
// (modules/website/publishing/snapshot.ts) and GET /api/export-static run before the
// payload is frozen into site.json / the static zip. Pure unit tests: the
// functions touch no DB.
import { describe, it, expect } from "vitest";
import {
  inertUnpublishedWikilinks,
  redactPayloadNodes,
} from "../modules/website/publishing/redaction.js";

describe("inertUnpublishedWikilinks — no private title leaks via wikilinks", () => {
  const published = [
    { title: "Public Page", slug: "public-page" },
    { title: "About", slug: "about" },
  ];

  it("keeps wikilinks whose target IS published", () => {
    expect(inertUnpublishedWikilinks("see [[Public Page]] here", published, "(private)")).toBe(
      "see [[Public Page]] here",
    );
  });

  it("redacts a wikilink to an UNPUBLISHED node — title must not appear", () => {
    const out = inertUnpublishedWikilinks("ref [[Secret Private Title]] end", published, "(private)");
    expect(out).not.toContain("Secret Private Title");
    expect(out).toBe("ref (private) end");
  });

  it("uses the author's explicit alias instead of leaking, but never the title", () => {
    const out = inertUnpublishedWikilinks("[[Secret Private Title|see notes]]", published, "(private)");
    expect(out).not.toContain("Secret Private Title");
    expect(out).toBe("see notes");
  });

  it("a link to a heading or block of a published note is kept; of an unpublished one, redacted with its heading", () => {
    expect(inertUnpublishedWikilinks("[[About#Team]] [[About#^b1]]", published, "(private)")).toBe("[[About#Team]] [[About#^b1]]");
    const out = inertUnpublishedWikilinks("[[Secret#Plans]]", published, "(private)");
    expect(out).toBe("(private)");
  });

  it("a link inside the same note is kept", () => {
    expect(inertUnpublishedWikilinks("[[#Team]] [[#^b1|up]]", published, "(private)")).toBe("[[#Team]] [[#^b1|up]]");
  });

  it("resolves a published target by slug-like normalization", () => {
    // "About" published by title → "[[about]]" / "[[About]]" both keep.
    expect(inertUnpublishedWikilinks("[[about]]", published, "(private)")).toBe("[[about]]");
  });
});

describe("inertUnpublishedWikilinks — a link by alias (the app's one link rule)", () => {
  const published = [{ title: "Onden Handbook", slug: "onden-handbook", aliases: ["Handbook", "手冊"] }];

  it("keeps a link that names a published note by one of its aliases", () => {
    expect(inertUnpublishedWikilinks("see [[handbook]] and [[手冊#安裝]]", published, "(private)")).toBe("see [[handbook]] and [[手冊#安裝]]");
  });

  it("still redacts a link whose name is no published note's title, slug or alias", () => {
    expect(inertUnpublishedWikilinks("[[Handbook draft]]", published, "(private)")).toBe("(private)");
  });
});

describe("redactPayloadNodes — scrubs every node's markdown in place", () => {
  it("inerts cross-links to nodes NOT in the published payload set", () => {
    const nodes = [
      { id: "n1", title: "Home", slug: "home", markdown: "link to [[Home]] and [[Private Draft]]" },
      { id: "n2", title: "Home2", slug: "home2", markdown: "another [[Home]]" },
    ];
    redactPayloadNodes(nodes, "(private)");
    // [[Home]] is in the set → kept; [[Private Draft]] is not → no title leak.
    expect(nodes[0].markdown).toContain("[[Home]]");
    expect(nodes[0].markdown).not.toContain("Private Draft");
    expect(nodes[0].markdown).toContain("(private)");
  });
});

describe("redactPayloadNodes — aliases", () => {
  it("keeps a cross-link by alias when the aliases are passed in", () => {
    const nodes = [
      { id: "n1", title: "Home", slug: "home", markdown: "read the [[Guide]]" },
      { id: "n2", title: "User guide", slug: "user-guide", markdown: "" },
    ];
    redactPayloadNodes(nodes, "(private)", undefined, new Map([["n2", ["Guide"]]]));
    expect(nodes[0].markdown).toBe("read the [[Guide]]");
    // The aliases are read beside the payload, never written into it.
    expect(nodes[1]).not.toHaveProperty("aliases");
  });
});
