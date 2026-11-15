// The published site draws a note with React (MarkdownRenderer, published
// profile), the exports with hast (backend md2html). Two renderers on purpose
// (React vs a static string), so this is the thing that keeps them from
// drifting: one fixture per element, both sides parsed to a DOM and compared
// by tag, classes (order ignored) and the attributes that matter. Where the
// two differ ON PURPOSE the case says why (DIFFERENT_BY_DESIGN) and pins both
// sides, so a change on either side still has to be noticed.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { EMBED_DEFAULT_TITLE, loadAllEnhancers } from "@onden/markdown";
import { md2html } from "../../../backend/src/modules/website/publishing/htmlUtils";
import { makeSiteMarkdown } from "../components/siteFrame/siteMarkdown";
import type { PublishedNode } from "../components/templates";

beforeAll(async () => { await loadAllEnhancers(); });

const KEPT_ATTRS = [
  "src", "href", "alt", "title", "sandbox", "allow", "allowfullscreen", "referrerpolicy", "loading", "controls", "role",
  "aria-checked", "aria-readonly", "preload", "aria-label", "aria-hidden", "data-audio-speed", "hidden", "type",
];

/** A DOM as lines `<tag.sorted.classes attr=…>` + text, indented: order of
 *  classes, whitespace and attributes the comparison doesn't name are ignored. */
function shape(html: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const out: string[] = [];
  const walk = (node: Node, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) out.push(`${pad}"${text}"`);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    // DIFFERENT_BY_DESIGN: MediaPlayer wraps a player in span.md-media-wrap
    // (display: contents) so React can fade it out on unmount; it draws nothing.
    if (node.classList.contains("md-media-wrap")) { node.childNodes.forEach((child) => walk(child, depth)); return; }
    // DIFFERENT_BY_DESIGN: the app's Pressable button carries its reset class (ui-pressable), which the exports' button does not need.
    const classes = [...node.classList].filter((c) => !c.startsWith("ui-")).sort().join(".");
    const attrs = KEPT_ATTRS.filter((a) => node.hasAttribute(a)).map((a) => `${a}=${JSON.stringify(node.getAttribute(a))}`).join(" ");
    out.push(`${pad}<${node.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${attrs ? ` ${attrs}` : ""}>`);
    node.childNodes.forEach((child) => walk(child, depth + 1));
  };
  root.childNodes.forEach((child) => walk(child, 0));
  return out;
}

const page = (markdown: string): PublishedNode => ({
  id: "p1", node_type: "content", title: "T", slug: "t", markdown: `# T\n\n${markdown}`,
  created_at: "2026-02-03T04:00:00Z", updated_at: "2026-03-04T04:00:00Z",
  query_blocks: [{ lang: "onden-query", source: 'tag:"x"', columns: [], rows: [{ id: "p1", title: "Alpha", slug: "t" }], more: 2 }],
});

const react = (markdown: string) => {
  const node = page(markdown);
  return shape(renderToStaticMarkup(<>{makeSiteMarkdown([node], { static: true })(markdown, "p1")}</>));
};
const hast = (markdown: string) => {
  const node = page(markdown);
  return shape(md2html(markdown, {
    pages: [{ id: "p1", title: "T", slug: "t", markdown: node.markdown }], from: "p1", queryBlocks: node.query_blocks, locale: "en",
  }));
};

const SAME = {
  "a bare YouTube link": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "a YouTube image link with a label": "![talk](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
  "a Vimeo image link without a label": "![](https://vimeo.com/76979871)",
  "a video file": "![clip](https://example.com/clip.mp4)",
  "an audio file": "![song](https://example.com/song.mp3)",
  "a link to an uploaded SVG": "[diagram](/media/diagram.svg)",
  "a task list": "- [ ] open\n- [x] done",
  "a plain link": "[site](https://example.com/x)",
} as const;

describe("the site (React) and the exports (hast) draw the same elements", () => {
  it.each(Object.entries(SAME))("%s", (_name, markdown) => {
    // The task list's <li>/<ul> classes come from the same remark pipeline;
    // comparing whole trees is the point.
    expect(react(markdown)).toEqual(hast(markdown));
  });

  it("an embed is drawn click-to-load: a span with the thumbnail as a link to the video, and the iframe address for the script", () => {
    const tree = react("https://www.youtube.com/watch?v=dQw4w9WgXcQ").join("\n");
    expect(tree).toContain("<span.md-embed.md-embed-lite>");
    expect(tree).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(tree).toContain('src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
    expect(tree).not.toContain("<iframe");
  });

  it("the iframe a press brings in sits inert in a <template>, the same on the site and in the exports, with the one sandbox / allow / referrer policy", () => {
    const md = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const templateOf = (html: string) => {
      const root = document.createElement("div");
      root.innerHTML = html;
      return root.querySelector("template")!.innerHTML;
    };
    const onSite = templateOf(renderToStaticMarkup(<>{makeSiteMarkdown([page(md)], { static: true })(md, "p1")}</>));
    const inExport = templateOf(md2html(md, { pages: [], locale: "en" }));
    expect(onSite).toContain('sandbox="allow-scripts allow-presentation allow-popups"');
    expect(onSite).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(onSite).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    // same attributes in the same order, whichever side wrote them (the title differs only by its default)
    const attrs = (html: string) => [...html.matchAll(/(\w+)=/g)].map((m) => m[1]);
    expect(attrs(inExport)).toEqual(attrs(onSite));
  });

  it("a Vimeo embed has no thumbnail: a neutral box naming the domain", () => {
    const tree = react("https://vimeo.com/76979871").join("\n");
    expect(tree).toContain('"vimeo.com"');
    expect(tree).not.toContain("<img");
  });

  it("an audio file has its speed button, hidden until a script shows it", () => {
    expect(react("![song](https://example.com/song.mp3)").join("\n")).toMatch(/<button\.md-audio-speed [^>]*data-audio-speed="" hidden=""/);
  });

  it("an uploaded video loads only its metadata and first frame", () => {
    expect(react("![clip](https://example.com/clip.mp4)").join("\n")).toContain('preload="metadata"');
  });

  it("an unlabelled embed's title is in the site's language on the exports (and English with none)", () => {
    const embed = "![](https://vimeo.com/76979871)";
    expect(shape(md2html(embed, { pages: [], locale: "zh-TW" })).join("\n")).toContain('aria-label="嵌入媒體"');
    expect(shape(md2html(embed, { pages: [], locale: "ja" })).join("\n")).toContain('aria-label="埋め込みメディア"');
    expect(shape(md2html(embed)).join("\n")).toContain('aria-label="Embedded media"');
  });

  it("the app's default embed title is the shared constant (EmbedIframe writes the literal so it is extracted for translation)", () => {
    expect(EMBED_DEFAULT_TITLE).toBe("Embedded media");
    expect(react("![](https://vimeo.com/76979871)").join("\n")).toContain(`aria-label="${EMBED_DEFAULT_TITLE}"`);
  });

  it("a feed body (static) has no copy button; a page does", () => {
    const code = "```js\nconst a = 1;\n```";
    expect(react(code).join("\n")).not.toContain("md-codeblock-copy");
    const interactive = renderToStaticMarkup(<>{makeSiteMarkdown([page(code)])(code, "p1")}</>);
    expect(interactive).toContain("md-codeblock-copy");
  });
});

// Each of these is a difference the two sides keep ON PURPOSE. Both sides are
// pinned: if either changes, the reason below has to be looked at again.
describe("DIFFERENT_BY_DESIGN", () => {
  it("a mermaid fence: the page shows code (diagrams off, no script on a static page); the exports ship the source as pre.mermaid", () => {
    const md = "```mermaid\ngraph TD; A-->B\n```";
    expect(react(md).join("\n")).toContain("<pre>");
    expect(react(md).join("\n")).toContain("graph TD; A-->B");
    expect(hast(md)[0]).toBe("<pre.mermaid>");
  });

  it("a frozen query: same content; the page wraps it in its own component's classes, the exports in onden-query-frozen", () => {
    const md = "```onden-query\ntag:\"x\"\n```";
    const onPage = react(md).join("\n");
    const inExport = hast(md).join("\n");
    for (const part of ['"Alpha"', '"+2 more"']) {
      expect(onPage).toContain(part);
      expect(inExport).toContain(part);
    }
  });

  it("a code block: the page wraps it with a copy button (an interactive control); the exports and the feed are a bare pre", () => {
    const md = "```js\nconst a = 1;\n```";
    expect(react(md)[0]).toBe("<pre>");
    expect(hast(md)[0]).toBe("<pre>");
  });
});
