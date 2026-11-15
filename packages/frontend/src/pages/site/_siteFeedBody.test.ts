import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { absoluteLinks, cdata, feedBodyHtml } from "./_siteFeedBody";
import type { PublishedNode } from "../../components/templates";

const node = (id: string, title: string, markdown: string): PublishedNode =>
  ({ id, node_type: "content", title, slug: id, markdown });

describe("feed item bodies", () => {
  beforeAll(async () => { await loadAllEnhancers(); });

  const nodes = [
    node("a", "Post", "# Post\n\nFull **text** here, with [[Other]] and ![pic](/api/media/pic.png).\n\n## Section\n\nmore"),
    node("b", "Other", "# Other\n\nbody"),
  ];

  it("carries the whole note — every paragraph and heading, not a summary — without its title line", () => {
    const html = feedBodyHtml(nodes, nodes[0]!, "https://garden.example");
    expect(html).toContain("<strong>text</strong>");
    expect(html).toContain("Section");
    expect(html).toContain("more");
    expect(html).not.toContain("<h1");
  });

  it("makes every site-relative address absolute with the public origin", () => {
    const html = feedBodyHtml(nodes, nodes[0]!, "https://garden.example");
    expect(html).toContain('href="https://garden.example/site/b"');
    expect(html).toContain('src="https://garden.example/api/media/pic.png"');
    expect(html).not.toMatch(/(?:href|src)="\/(?!\/)/);
  });

  it("a link to a note that is not on the site is plain text, never an address", () => {
    const only = [nodes[0]!]; // Other is not published
    const html = feedBodyHtml(only, only[0]!, "https://garden.example");
    expect(html).not.toContain("/site/b");
    expect(html).toContain("Other");
  });

  it("leaves out the copy button of a code block, which needs script", () => {
    const code = node("c", "Code", "# Code\n\n```js\nconst a = 1;\n```");
    const html = feedBodyHtml([code], code, "https://garden.example");
    expect(html).toContain("const");
    expect(html).not.toContain("<button");
  });

  it("absoluteLinks leaves other hosts and protocol-relative addresses alone", () => {
    expect(absoluteLinks('<a href="https://x.test/a">x</a><img src="//cdn.test/i.png"><a href="#top">t</a>', "https://o.test"))
      .toBe('<a href="https://x.test/a">x</a><img src="//cdn.test/i.png"><a href="#top">t</a>');
  });

  it("cdata survives a body that contains the closing marker", () => {
    const wrapped = cdata("a ]]> b");
    expect(wrapped).toBe("<![CDATA[a ]]]]><![CDATA[> b]]>");
  });
});
