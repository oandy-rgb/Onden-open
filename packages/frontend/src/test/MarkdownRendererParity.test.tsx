// Renderer parity (W38c, @onden/markdown): every surface renders mermaid,
// KaTeX and callouts the same way —
//   • OverviewPreview (the editor's preview mode + note history) renders a
//     mermaid block to an svg container and a callout with its class;
//   • the published profile renders callouts too, and shows inline HTML as
//     text where the app profile renders it;
//   • CardNode (canvas inline preview) DELIBERATELY leaves mermaid as code
//     (diagrams={false}) — hundreds of cards lazy-loading mermaid would be a
//     perf regression — pinned by rendering a CardNode.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import OverviewPreview from "../components/OverviewPreview";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { CardNode } from "../components/CardNode";
import { ReaderArticle } from "../components/markdownSurfaces";
import { makeSiteMarkdown } from "../components/siteFrame/siteMarkdown";

// MermaidBlock lazy-imports mermaid; stub the heavy lib with a deterministic
// svg emitter so the async render path is exercised without the real parser.
// OndenQueryBlock POSTs to /api/query; answer with an empty result.
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  apiFetch: vi.fn(async () => ({ rows: [], total: 0, next: null })),
}));

vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-mock-mermaid="1"></svg>' })),
  },
}));


describe("in-app markdown renderer parity", () => {
  it("OverviewPreview renders a mermaid block into the svg container", async () => {
    const md = "```mermaid\ngraph TD; A-->B;\n```";
    const { container } = render(
      <OverviewPreview draft={md} nodes={[]} onOpenWikilink={() => {}} />,
    );
    await waitFor(() => {
      const block = container.querySelector(".md-mermaid");
      expect(block).not.toBeNull();
      expect(block!.innerHTML).toContain("data-mock-mermaid");
    });
  });

  it("OverviewPreview renders a callout with its type class", () => {
    const md = "> [!note] Heads up\n> body line";
    const { container } = render(
      <OverviewPreview draft={md} nodes={[]} onOpenWikilink={() => {}} />,
    );
    const callout = container.querySelector(".callout.callout-note");
    expect(callout).not.toBeNull();
    expect(callout!.querySelector(".callout-title")?.textContent).toBe("Heads up");
    expect(callout!.textContent).not.toContain("NOTE");
    expect(callout!.textContent?.match(/Heads up/g)).toHaveLength(1);
  });

  it("OverviewPreview renders a folded callout as a details you can open (- closed, + open)", () => {
    const render1 = (md: string) => render(<OverviewPreview draft={md} nodes={[]} onOpenWikilink={() => {}} />).container;
    const closed = render1("> [!tip]- Why\n> because").querySelector("details.callout.callout-tip") as HTMLDetailsElement;
    expect(closed).not.toBeNull();
    expect(closed.open).toBe(false);
    expect(closed.querySelector("summary.callout-title")?.textContent).toBe("Why");
    const open = render1("> [!tip]+ Why\n> because").querySelector("details.callout") as HTMLDetailsElement;
    expect(open.open).toBe(true);
  });

  it("with diagrams off (CardNode's configuration) a mermaid block stays a plain code block", () => {
    const md = "```mermaid\ngraph TD; A-->B;\n```";
    const { container } = render(<MarkdownRenderer diagrams={false}>{md}</MarkdownRenderer>);
    expect(container.querySelector(".md-mermaid")).toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
  });

  it("CardNode's inline preview keeps diagrams off (perf): a mermaid fence stays a code block", () => {
    const card = { id: "n1", type: "card", selected: false, data: { label: "Card", content: "```mermaid\ngraph TD; A-->B;\n```" } };
    const { container } = render(<CardNode {...(card as unknown as Parameters<typeof CardNode>[0])} />);
    expect(container.querySelector(".md-mermaid")).toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
  });

  it("the published profile renders callouts and shows inline HTML as text; the app profile renders it", () => {
    const md = "> [!tip] Try\n> this\n\nPress <kbd>Ctrl</kbd>.";
    const site = render(<MarkdownRenderer profile="published">{md}</MarkdownRenderer>).container;
    expect(site.querySelector(".callout.callout-tip")).not.toBeNull();
    expect(site.querySelector("kbd")).toBeNull();
    expect(site.textContent).toContain("<kbd>Ctrl</kbd>");
    const app = render(<MarkdownRenderer>{md}</MarkdownRenderer>).container;
    expect(app.querySelector(".callout.callout-tip")).not.toBeNull();
    expect(app.querySelector("kbd")?.textContent).toBe("Ctrl");
  });

  // Code-fence highlighting: previously only ~11 hand-registered languages
  // highlighted (with detect off), so a ```java / ```yaml fence — or an
  // untagged fence — fell back to flat plain text. The renderer now defaults to
  // lowlight's `common` set + auto-detect, so a far broader range highlights.
  it("highlights a language that was not in the old hand-registered set (java)", async () => {
    const md = "```java\npublic class A { int x = 1; }\n```";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    // hljs emits <span class="hljs-…"> tokens when a fence is highlighted;
    // the grammar loads on demand, so they arrive after the first render.
    await waitFor(() => expect(container.querySelector("code [class*='hljs-']")).not.toBeNull());
  });

  it("auto-detects and highlights an UNTAGGED fence (detect fallback)", async () => {
    const md = "```\nimport os\ndef greet(name):\n    return f'hi {name}'\n```";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    await waitFor(() => expect(container.querySelector("code [class*='hljs-']")).not.toBeNull());
  });

  it("convenience aliases (ts) still resolve to a highlighted language", async () => {
    const md = "```ts\nconst x: number = 1;\n```";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    await waitFor(() => expect(container.querySelector("code [class*='hljs-']")).not.toBeNull());
  });

  it("loads KaTeX when a note has math: the source shows first, then the formula", async () => {
    const { container } = render(<MarkdownRenderer>{"Euler: $e^{i\\pi}+1=0$"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
    expect(container.querySelector(".katex-mathml")).not.toBeNull();
  });

  it("highlights an indented block the source scan can't see once it is reported", async () => {
    const { container } = render(<MarkdownRenderer>{"Text\n\n    import os\n    def f(x):\n        return x\n"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector("pre code [class*='hljs-']")).not.toBeNull());
  });

  // Rendered fenced-code blocks get a small copy-to-clipboard button; clicking
  // it writes the block's source text. onden-query / mermaid custom blocks are
  // NOT plain code, so they stay bare (no spurious copy button).
  it("a plain fenced-code block renders a copy button that copies the source", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const md = "```js\nconst a = 1;\n```";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const btn = container.querySelector("button.md-codeblock-copy");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;"));
  });

  it("onden-query blocks do NOT get a copy button (not plain code)", () => {
    const md = "```onden-query\ntag: foo\n```";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("button.md-codeblock-copy")).toBeNull();
  });

  // ⑨ Obsidian beat: a [[wikilink]] renders as a NAVIGABLE button, and an
  // unresolved one is still clickable (its handler creates the note). This
  // broke in the `raw` pipeline (preview) because rehype-sanitize strips the
  // wiki-link plugin's className — detection now rides a `#wl:` href sentinel.
  const oneNode = [{ id: "n1", slug: "known-note", title: "Known Note" } as never];
  for (const profile of ["published", "app"] as const) {
    it(`wikilinks navigate in the ${profile} profile; unresolved still clickable`, () => {
      const navs: Array<[string, string | null]> = [];
      const { container } = render(
        <MarkdownRenderer
          nodes={oneNode}
          onNavigate={(slug, id) => navs.push([slug, id])}
          profile={profile}
        >
          {"See [[Known Note]] and [[Ghost Note]]."}
        </MarkdownRenderer>,
      );
      const buttons = Array.from(container.querySelectorAll("button.wikilink-token"));
      expect(buttons).toHaveLength(2);
      // the resolved link is marked `known`, the unresolved one is not
      expect(buttons[0].className).toContain("known");
      expect(buttons[1].className).not.toContain("known");
      // NOT a dead <a> — the regression we fixed left an <a> with no handler
      expect(container.querySelector("a[target='_blank']")).toBeNull();

      fireEvent.click(buttons[0]);
      fireEvent.click(buttons[1]);
      // resolved → (slug, id); unresolved → (label, null) so the caller creates it
      expect(navs[0]).toEqual(["known-note", "n1"]);
      expect(navs[1]).toEqual(["Ghost Note", null]);
    });
  }

  // W2 P2 block references: a `[[Note#^id]]` link carries the block id all the
  // way to onNavigate (so the host can scroll to it).
  it("a [[Note#^block]] reference forwards the block id", () => {
    const navs: Array<[string, string | null, string | undefined]> = [];
    const { container } = render(
      <MarkdownRenderer
        nodes={oneNode}
        linkStyle="published"
        onNavigate={(slug, id, blockId) => navs.push([slug, id, blockId])}
      >
        {"See [[Known Note#^abc123]] for details."}
      </MarkdownRenderer>,
    );
    const btn = container.querySelector("button.published-inline-link");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(navs[0]).toEqual(["known-note", "n1", "abc123"]);
  });

  // D42 option 3: the snapshot rewrites `[[alias]]` to `[[<served slug>|alias]]`
  // and lists no aliases; the published site links it by the slug and shows
  // the alias. A link to no page stays unlinked.
  it("the published site links a link rewritten from an alias, showing the alias", () => {
    const body = makeSiteMarkdown([{ id: "t1", node_type: "content", title: "Target", slug: "target-t10000", markdown: "" }]);
    const { container } = render(<>{body("[[target-t10000|My Alias]] and [[My Alias]]")}</>);
    const alias = container.querySelector("a.published-inline-link")!;
    expect(alias.textContent).toBe("My Alias");
    expect(alias.getAttribute("href")).toBe("/site/target-t10000");
    expect(container.querySelectorAll("a.published-inline-link")).toHaveLength(1);
    expect(container.textContent).toContain("My Alias and My Alias");
  });

  // GAP-162: the `code` override read the fence language with /language-(\w+)/,
  // so `onden-query` / `onden-base` became `onden` and never rendered.
  it("renders onden-query and onden-base fences as blocks, not plain code", async () => {
    const q = render(<MarkdownRenderer>{"```onden-query\ntags: x\n```"}</MarkdownRenderer>);
    await waitFor(() => expect(q.container.querySelector(".onden-query-block")).not.toBeNull());
    expect(q.container.querySelector("code.language-onden-query")).toBeNull();
    const b = render(<MarkdownRenderer>{"```onden-base\nviews:\n  - type: table\n```"}</MarkdownRenderer>);
    expect(b.container.querySelector("code.language-onden-base")).toBeNull();
  });

  it("footnote links stay in the page and both ends have their targets", () => {
    const { container } = render(<MarkdownRenderer profile="published">{"A claim[^1].\n\n[^1]: The source."}</MarkdownRenderer>);
    const links = Array.from(container.querySelectorAll("a[href^='#']"));
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("target")).toBeNull();
      expect(container.querySelector(`[id="${a.getAttribute("href")!.slice(1)}"]`)).not.toBeNull();
    }
  });

  it("the RSS reader keeps dollar amounts as text (math off for text not written in Onden)", () => {
    const { container } = render(<ReaderArticle resolveImage={(src) => src}>{"Price $5 to $10 today<br>"}</ReaderArticle>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("Price $5 to $10 today");
  });

  it("the RSS reader draws a page's HTML as the page, not as code, whatever its blank lines and indentation", () => {
    const page = [
      '<div class="article-layout">', "", "", '  <main class="post-main">', '    <div class="post-header-inline">', "",
      "      <h1>Bags</h1>", "    </div>", "", '    <div class="post-content-body">', "      <p>A month later.</p>", "",
      '      <img src="https://blog.test/bags.jpg"', '           alt="bags" />', "",
      "      <pre><code>line one", "", "    line three</code></pre>", "    </div>", "  </main>", "</div>",
    ].join("\n");
    const { container } = render(<ReaderArticle resolveImage={(src) => src}>{page}</ReaderArticle>);
    expect(container.textContent).not.toContain("<");
    expect(container.querySelector("h1")?.textContent).toBe("Bags");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://blog.test/bags.jpg");
    // The one code block is the page's own, with its blank line and indentation kept.
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre")!.textContent).toContain("line one\n\n    line three");
  });

  it("the RSS reader keeps an image's caption as a caption element right after the image", () => {
    const page = '<p><div>\n  <a href="https://blog.test/a.jpg">\n    <img src="https://blog.test/a.jpg" alt="a" />\n  </a>\n\n    <figcaption>the caption</figcaption>\n\n</div></p>\n<p>Body text.</p>';
    const { container } = render(<ReaderArticle resolveImage={(src) => src}>{page}</ReaderArticle>);
    const caption = container.querySelector("figcaption");
    expect(caption?.textContent).toBe("the caption");
    expect(caption?.parentElement?.querySelector("img")).not.toBeNull();
    expect(container.textContent).not.toContain("<");
  });

  it("the RSS reader leaves a body with no tags as it was (a text-only feed keeps its paragraphs)", () => {
    const { container } = render(<ReaderArticle resolveImage={(src) => src}>{"First paragraph.\n\nSecond paragraph."}</ReaderArticle>);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("the published profile renders the editor's own tags (<u>, <mark>, players), nothing else", () => {
    const md = 'An <u>under</u>, a <mark>mark</mark>, <kbd>K</kbd>.\n\n<video controls src="https://cdn.example/a.mp4"></video>';
    const site = render(<MarkdownRenderer profile="published">{md}</MarkdownRenderer>).container;
    expect(site.querySelector("u")?.textContent).toBe("under");
    expect(site.querySelector("mark")?.textContent).toBe("mark");
    expect(site.querySelector("video")?.getAttribute("src")).toBe("https://cdn.example/a.mp4");
    expect(site.querySelector("kbd")).toBeNull();
  });

  it("hides only the key:: value line, keeping the prose joined to it (D34)", () => {
    const md = "Intro.\n\ndue:: 2026-10-20\nCall the lawyer about the contract.\n\nEnd.";
    for (const profile of ["app", "published"] as const) {
      const { container, unmount } = render(<MarkdownRenderer profile={profile}>{md}</MarkdownRenderer>);
      expect(container.textContent).not.toContain("due::");
      expect(container.textContent).toContain("Call the lawyer about the contract.");
      unmount();
    }
  });

  it("hides a block's {tag} mark in the rendered page", () => {
    const { container } = render(
      <OverviewPreview draft={"- [ ] 編譯器作業 {task}\n"} nodes={[]} onOpenWikilink={() => {}} />,
    );
    expect(container.textContent).not.toContain("{task}");
    expect(container.textContent).toContain("編譯器作業");
    expect(container.querySelector('[data-block-tags="task"]')).not.toBeNull();
  });
});
