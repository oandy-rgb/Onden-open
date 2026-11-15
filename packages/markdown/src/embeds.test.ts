import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { embedBodyOfSrc, embedLabel, embedLine, embedMatches, parseEmbed } from "./embeds.js";
import { ondenMarkdown } from "./full.js";

function html(markdown: string, embeds: boolean): string {
  const md = ondenMarkdown({ profile: "app", embeds, wikilinkHref: ({ target }) => `#wl:${target}` });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

describe("![[…]] embeds", () => {
  it("parses the note part, block id and label", () => {
    expect(parseEmbed("2025-12-08 09.58.38.excalidraw")).toMatchObject({ target: "2025-12-08 09.58.38.excalidraw", blockId: null, label: null });
    expect(parseEmbed("Note#^abc-1|see")).toMatchObject({ target: "Note", blockId: "abc-1", label: "see" });
    expect(parseEmbed("Note#Heading")).toMatchObject({ target: "Note", blockId: null, heading: "Heading" });
    expect(parseEmbed("Note#^b1")).toMatchObject({ target: "Note", blockId: "b1", heading: null });
    expect(parseEmbed("Note|label")).toMatchObject({ target: "Note", heading: null, label: "label" });
    expect(embedLabel(parseEmbed("x.excalidraw"))).toBe("x");
    expect(embedLabel(parseEmbed("x.excalidraw|My pic"))).toBe("My pic");
  });

  it("finds embeds, not plain links, on one line each", () => {
    const text = "a [[link]] ![[one]] b\n![[two|T]]\n![[broken\n]]";
    expect(embedMatches(text).map((m) => [m.target, text.slice(m.start, m.end)])).toEqual([
      ["one", "![[one]]"], ["two", "![[two|T]]"],
    ]);
  });

  it("a line that is only an embed", () => {
    expect(embedLine("  ![[d.excalidraw]] ")?.target).toBe("d.excalidraw");
    expect(embedLine("x ![[d]]")).toBeNull();
    expect(embedLine("![[a]] ![[b]]")).toBeNull();
    expect(embedLine("[[a]]")).toBeNull();
  });

  it("the pipeline turns an embed into an image with the #embed: sentinel, only when asked", () => {
    const on = html("before\n\n![[2025-12-08 09.58.38.excalidraw]]\n\nx ![[b|c]] y `![[code]]`", true);
    const src = /<img src="([^"]+)" alt="2025-12-08 09.58.38">/.exec(on)?.[1];
    expect(src).toBeTruthy();
    expect(embedBodyOfSrc(src!.replace(/&#x26;/g, "&"))).toBe("2025-12-08 09.58.38.excalidraw");
    expect(on).toContain('alt="c"');
    expect(on).toContain("<code>![[code]]</code>");
    const off = html("![[2025-12-08 09.58.38.excalidraw]]", false);
    expect(off).not.toContain("<img");
    expect(off).toContain("![[2025-12-08 09.58.38.excalidraw]]");
  });

  it("only #embed: srcs name an embed", () => {
    expect(embedBodyOfSrc("#embed:a%20b")).toBe("a b");
    expect(embedBodyOfSrc("/api/media/x.png")).toBeNull();
    expect(embedBodyOfSrc("#embed:%E0%A4%A")).toBeNull();
  });
});
