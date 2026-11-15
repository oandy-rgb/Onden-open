import { cleanup, render } from "@testing-library/react";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deckVars } from "@onden/site/look";
import { LAYOUT_IDS, layoutOfPage, pagesOf } from "../pages";
import SlideView from "../SlideView";
import { slideRenderer } from "../slideRender";
import { themeStyle } from "../theme";
import { buildDeckSpec, inch, MISSING_PICTURE_FILL, notesText, type DeckSpec, type ElementSpec, type MasterLook } from "./deckSpec";
import { fontFile, substitutions } from "./fonts";
import { masterLookOf, pictureLosses } from "./look";
import type { MeasuredSlide, TextItem } from "./measured";
import { fittedBox, parseColor, readSlideCanvas } from "./readCanvas";
import { placeElements } from "./testkit";
import { withoutStrayParagraphProps, writePptx } from "./writePptx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SAMPLE = `# 期末專題：課堂即時問答系統
第一組 · 2026/12

---

## 為什麼要做
- 上課問問題的人很少
- 老師不知道大家聽懂沒

這段是講稿。

---

## 三個功能
- 匿名提問
- 即時投票
- 課後整理

---

> 「最好的問題，常常是沒人敢問的那一個。」`;

const look = (scheme: "light" | "dark" = "light"): MasterLook => {
  const style = { preset: "quiet", accent: "#3f7d6e", scheme } as const;
  return masterLookOf(style, deckVars(style));
};

const textItem = (over: Partial<TextItem> = {}): TextItem => ({
  kind: "text", role: "other", box: { x: 96, y: 96, w: 960, h: 120 }, font: "sans", sizePx: 43, lineHeightPx: 60, color: "#222222",
  bold: false, align: "left", indentPx: 56, paragraphs: [{ runs: [{ text: "hello" }], spaceBeforePx: 0, spaceAfterPx: 0 }], ...over,
});

const slideOf = (items: MeasuredSlide["items"], background = "#ffffff"): MeasuredSlide => ({ background, contentBottom: 984, inlineFormulas: 0, items });
const texts = (spec: DeckSpec, slide = 0) => spec.slides[slide]!.elements.filter((e): e is Extract<ElementSpec, { type: "text" }> => e.type === "text");

describe("the deck spec", () => {
  it("measures in inches: 1920 px across is a 13.333 in slide", () => {
    expect(inch(1920)).toBeCloseTo(13.333, 2);
    expect(inch(96)).toBeCloseTo(0.667, 2);
  });

  it("puts the first title and the first main body in the master's placeholders, and the rest in plain boxes", () => {
    const spec = buildDeckSpec({
      look: look(), font: "common",
      slides: [{ notes: "", measured: slideOf([textItem({ role: "title" }), textItem({ role: "body" }), textItem({ role: "body" }), textItem({ role: "other" })]) }],
    });
    expect(texts(spec).map((e) => e.placeholder)).toEqual(["title", "body", undefined, undefined]);
  });

  it("writes a list as real bullets with their depth, and keeps bold, italic and links on their runs", () => {
    const item = textItem({
      role: "body",
      paragraphs: [
        { runs: [{ text: "first " }, { text: "bold", bold: true }, { text: " link", link: "https://example.com", italic: true }], list: { level: 0, numbered: false }, spaceBeforePx: 0, spaceAfterPx: 0 },
        { runs: [{ text: "child" }], list: { level: 1, numbered: false }, spaceBeforePx: 8, spaceAfterPx: 0 },
        { runs: [{ text: "step" }], list: { level: 0, numbered: true }, spaceBeforePx: 8, spaceAfterPx: 0 },
      ],
    });
    const [element] = texts(buildDeckSpec({ look: look(), font: "common", slides: [{ notes: "", measured: slideOf([item]) }] }));
    const runs = element!.runs;
    expect(runs[0]!.options).toMatchObject({ bullet: { indent: 28 }, indentLevel: 0, fontSize: 21.5 });
    expect(runs[1]!.options.bold).toBe(true);
    expect(runs[2]!.options).toMatchObject({ italic: true, hyperlink: { url: "https://example.com" }, breakLine: true });
    expect(runs[3]!.options).toMatchObject({ indentLevel: 1 });
    expect(runs[4]!.options.bullet).toMatchObject({ type: "number" });
  });

  it("turns a formula into a picture, and a picture that could not be read into a grey box (counted)", () => {
    const spec = buildDeckSpec({
      look: look(), font: "common",
      slides: [
        { notes: "", measured: slideOf([{ kind: "picture", why: "math", box: { x: 0, y: 0, w: 400, h: 100 }, alt: "x^2", data: "data:image/png;base64,AAAA" }]) },
        { notes: "", measured: slideOf([{ kind: "picture", why: "image", box: { x: 0, y: 0, w: 400, h: 100 }, alt: "", data: null }]) },
      ],
    });
    expect(spec.slides[0]!.elements[0]).toMatchObject({ type: "image", data: "image/png;base64,AAAA", altText: "x^2" });
    expect(spec.slides[1]!.elements[0]).toMatchObject({ type: "shape", options: { fill: { color: MISSING_PICTURE_FILL } } });
    expect(spec.missingPictures).toEqual([{ slide: 1, count: 1 }]);
  });

  it("sets a slide's own page colour only when it differs from the master's (a cover on the accent)", () => {
    const l = look();
    const spec = buildDeckSpec({ look: l, font: "common", slides: [{ notes: "", measured: slideOf([], l.background) }, { notes: "", measured: slideOf([], "#336655") }] });
    expect(spec.slides.map((s) => s.background)).toEqual([null, "336655"]);
  });

  it("draws code as mono text with its colours in runs", () => {
    const spec = buildDeckSpec({
      look: look(), font: "common",
      slides: [{ notes: "", measured: slideOf([{ kind: "code", box: { x: 0, y: 0, w: 900, h: 300 }, lines: [[{ text: "const", color: "#aa0000" }, { text: " x" }], [{ text: "y" }]], sizePx: 30, lineHeightPx: 44, color: "#111111", fill: "#f4f4f4", line: "#dddddd", paddingPx: 24 }]) }],
    });
    const [code] = texts(spec);
    expect(code!.runs.map((r) => r.options.fontFace)).toEqual(["Consolas", "Consolas", "Consolas"]);
    expect(code!.runs[0]!.options.color).toBe("AA0000");
    expect(code!.options.fill).toEqual({ color: "F4F4F4" });
  });

  it("keeps the speaker's paragraphs apart as notes", () => {
    expect(notesText("one **a**\n\ntwo", (p) => p.replace(/\*/g, ""))).toBe("one a\n\ntwo");
  });
});

describe("fonts", () => {
  it("names the faces by the chosen set, and lists what is replaced", () => {
    expect(fontFile("sans", "common")).toBe("Microsoft JhengHei");
    expect(fontFile("serif", "common")).toBe("PMingLiU");
    expect(fontFile("kai", "common")).toBe("DFKai-SB");
    expect(fontFile("sans", "noto")).toBe("Noto Sans TC");
    expect(fontFile("serif", "keep")).toBe("Noto Serif TC");
    expect(substitutions(["sans", "sans", "serif"], "common")).toEqual([{ from: "Noto Sans TC", to: "Microsoft JhengHei" }, { from: "Noto Serif TC", to: "PMingLiU" }]);
    expect(substitutions(["sans"], "noto")).toEqual([]);
    expect(substitutions(["sans"], "keep")).toEqual([]);
  });
});

describe("the three themes", () => {
  it("make three masters: the website's, dark, and paper", () => {
    const site = { preset: "quiet", accent: "#3f7d6e", scheme: "light" } as const;
    const masters = (["site", "dark", "paper"] as const).map((theme) => {
      const style = themeStyle(theme, site, "light");
      return buildDeckSpec({ look: masterLookOf(style, deckVars(style)), font: "common", slides: [] }).master;
    });
    expect(new Set(masters.map((m) => m.background)).size).toBe(3);
    expect(masters[2]!.title.fontFace).toBe("PMingLiU"); // paper is set in serif
    expect(masters[0]!.title.fontFace).toBe("Microsoft JhengHei");
  });
});

describe("what a PPTX cannot keep editable", () => {
  it("finds the slides with a formula block or a diagram", () => {
    const pages = pagesOf("## A\n- the area is $x^2$\n\n---\n\n## B\n```mermaid\ngraph TD\nA-->B\n```\n\n---\n\n## C\n- costs $5 and $10\n```ts\nconst a = 1;\n```\n\n---\n\n## D\n$$\nE=mc^2\n$$\n- x");
    expect(pictureLosses(pages)).toEqual([{ kind: "math", slides: [4] }, { kind: "diagram", slides: [2] }]);
  });
});

describe("reading", () => {
  it("parses the colours the browser reports", () => {
    expect(parseColor("rgb(255, 0, 16)")).toEqual({ hex: "#ff0010", alpha: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ hex: "#000000", alpha: 0.5 });
    expect(parseColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseColor("color(srgb 1 0 0 / 0.5)")).toEqual({ hex: "#ff0000", alpha: 0.5 });
    expect(parseColor("#abc")).toEqual({ hex: "#aabbcc", alpha: 1 });
  });

  it("puts a contained picture where its content is, and fills the box otherwise", () => {
    const box = { x: 0, y: 0, w: 400, h: 400 };
    expect(fittedBox(box, { w: 200, h: 100 }, "contain")).toEqual({ x: 0, y: 100, w: 400, h: 200 });
    expect(fittedBox(box, { w: 200, h: 100 }, "cover")).toBe(box);
  });

  it("reads every layout into text, with the title first, in the page's own words", () => {
    placeElements();
    const pages = pagesOf(SAMPLE);
    const deck = pagesOf("# T\nsub\n\n---\n\n## S\n\n---\n\n## B\n- one\n- two\n  - nested\n\n---\n\n## P\n\nsentence one.\n\nsentence two.\n\n---\n\n## M\n![pic](a.png)\n- word\n\n---\n\n## Q\n> quote\n\n---\n\n## C\n### Left\n- a\n### Right\n- b\n- c\n\n---\n\n## Th\n- a\n- b\n- c\n\n---\n\n## St\n- 90% stay\n- 3x faster\n\n---\n\n## Ti\n- 2024 start\n- 2025 grow\n- 2026 ship\n\n---\n\n## Code\n```ts\nconst x = 1;\n```");
    const seen = new Set<string>();
    for (const layout of LAYOUT_IDS) {
      for (const page of [...pages, ...deck]) {
        const { container, unmount } = render(<SlideView page={page} layout={layout} vars={deckVars({ preset: "quiet", accent: "#3f7d6e", scheme: "light" })} render={slideRenderer([], null)} />);
        const measured = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
        const spec = buildDeckSpec({ look: look(), font: "common", slides: [{ measured, notes: "" }] });
        // A layout may have nothing to show of a page (a cover has no place for a quote): then there is nothing to read.
        if (container.textContent?.trim()) expect(spec.slides[0]!.elements.length, `${layout} / ${page.key}`).toBeGreaterThan(0);
        for (const item of measured.items) for (const n of [item.box.x, item.box.y, item.box.w, item.box.h]) expect(Number.isFinite(n)).toBe(true);
        seen.add(layout);
        unmount();
      }
    }
    expect([...seen].sort()).toEqual([...LAYOUT_IDS].sort());
  });

  it("leaves a code block's copy button off the slide, and keeps a paragraph with a wikilink in one piece", () => {
    placeElements();
    const { container } = render(
      <div className="sv-canvas">
        <h2 className="sv-title">T</h2>
        <div className="sv-body">
          <p>before <button className="wikilink-token">Other note</button> after <strong>bold</strong></p>
          <div className="md-codeblock"><button type="button" className="md-codeblock-copy">複製</button><pre><code>x = 1</code></pre></div>
        </div>
      </div>,
    );
    const slide = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
    expect(JSON.stringify(slide.items)).not.toContain("複製");
    const paragraphs = slide.items.filter((i): i is TextItem => i.kind === "text" && i.role === "body");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.paragraphs[0]!.runs.map((r) => r.text).join("")).toBe("before Other note after bold");
    expect(paragraphs[0]!.paragraphs[0]!.runs.find((r) => r.bold)?.text).toBe("bold");
  });

  it("reads a table's cells as plain boxes, each with its words and its own place, none of them the body placeholder", () => {
    placeElements();
    const { container } = render(
      <div className="sv-canvas">
        <h2 className="sv-title">T</h2>
        <div className="sv-body"><table><thead><tr><th>原因</th><th>Lexis</th></tr></thead><tbody><tr><td>檢索太天真</td><td>47%</td></tr></tbody></table></div>
      </div>,
    );
    const slide = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
    const cells = slide.items.filter((i): i is TextItem => i.kind === "text" && i.role !== "title");
    expect(cells.map((c) => c.paragraphs[0]!.runs.map((r) => r.text).join(""))).toEqual(["原因", "Lexis", "檢索太天真", "47%"]);
    expect(cells.every((c) => c.role === "other")).toBe(true);
  });

  it("keeps a table header's accent line under it as a line of its own, and adds none to a plain cell", () => {
    placeElements();
    const { container } = render(
      <div className="sv-canvas">
        <h2 className="sv-title">T</h2>
        <div className="sv-body"><table><tbody><tr>
          <th style={{ border: "1px solid #cccccc", borderBottom: "2px solid #3f7d6e" }}>原因</th>
          <td style={{ border: "1px solid #cccccc" }}>47%</td>
        </tr></tbody></table></div>
      </div>,
    );
    const slide = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
    const lines = slide.items.filter((i) => i.kind === "shape" && i.fill === "#3f7d6e" && i.line === null);
    expect(lines).toHaveLength(1);
  });

  it("skips anything drawn with no opacity, whatever its class", () => {
    placeElements();
    const { container } = render(<div className="sv-canvas"><h2 className="sv-title">T</h2><div className="sv-body"><p>shown</p><button style={{ opacity: 0 }}>hidden</button></div></div>);
    expect(JSON.stringify(readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!).items)).not.toContain("hidden");
  });

  it("writes a formula inside a line once, as its TeX, and counts it; a task box is ☑ or ☐", () => {
    placeElements();
    const math = '<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span>';
    const html = `<div class="sv-body"><ul><li><span class="md-checkbox checked"></span>done</li><li><span class="md-checkbox"></span>todo</li><li>area ${math} here</li></ul></div>`;
    const { container } = render(<div className="sv-canvas" dangerouslySetInnerHTML={{ __html: html }} />);
    const slide = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
    const list = slide.items.find((i): i is TextItem => i.kind === "text")!;
    expect(list.paragraphs.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["☑ done", "☐ todo", "area x^2 here"]);
    expect(slide.inlineFormulas).toBe(1);
  });

  it("leaves a place, without data, for a diagram that is not drawn or has an error, even inside a <pre>", () => {
    placeElements();
    for (const html of ['<div class="md-mermaid"></div>', '<p class="md-mermaid-error">error</p>', '<pre><div class="md-mermaid"></div></pre>']) {
      const { container, unmount } = render(<div className="sv-canvas" dangerouslySetInnerHTML={{ __html: `<h2 class="sv-title">T</h2>${html}` }} />);
      const pictures = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!).items.filter((i) => i.kind === "picture");
      expect(pictures, html).toHaveLength(1);
      expect(pictures[0]).toMatchObject({ why: "diagram", data: null });
      const spec = buildDeckSpec({ look: look(), font: "common", slides: [{ notes: "", measured: readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!) }] });
      expect(spec.missingPictures).toEqual([{ slide: 0, count: 1 }]);
      unmount();
    }
  });

  it("keeps an undrawn diagram's grey box inside the page's content area", () => {
    placeElements();
    const { container } = render(<div className="sv-canvas" style={{ paddingBottom: "96px" }} dangerouslySetInnerHTML={{ __html: '<div class="md-mermaid"></div>' }} />);
    const [picture] = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!).items;
    expect(picture!.box.y + picture!.box.h).toBeLessThanOrEqual(1080 - 96 + 50); // never below the content bottom, but at least the room it has
  });

  it("reads a bulleted page: the title, a real list with its nesting, and bold/links on their runs", () => {
    placeElements();
    const [page] = pagesOf("## Plan\n- **now** do [it](https://example.com)\n- later\n  - child");
    const { container } = render(<SlideView page={page!} layout={layoutOfPage(page!, {})} vars={deckVars({ preset: "quiet", accent: "#3f7d6e", scheme: "light" })} render={slideRenderer([], null)} />);
    const items = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!).items.filter((i): i is TextItem => i.kind === "text");
    expect(items[0]).toMatchObject({ role: "title" });
    expect(items[0]!.paragraphs[0]!.runs[0]!.text).toBe("Plan");
    const list = items.find((i) => i.role === "body")!;
    expect(list.paragraphs.map((p) => p.list?.level)).toEqual([0, 0, 1]);
    expect(list.paragraphs[0]!.runs.find((r) => r.link)).toMatchObject({ text: "it", link: "https://example.com" });
    expect(list.paragraphs[0]!.runs[0]).toMatchObject({ text: "now", bold: true });
  });
});

describe("the file", () => {
  it("keeps a self-closing pPr from swallowing what follows", () => {
    const xml = '<a:p><a:r>a</a:r><a:pPr/><a:r>b</a:r></a:p><a:p><a:pPr algn="l"/><a:r>c</a:r></a:p>';
    expect(withoutStrayParagraphProps(xml)).toBe('<a:p><a:r>a</a:r><a:r>b</a:r></a:p><a:p><a:pPr algn="l"/><a:r>c</a:r></a:p>');
  });

  it("cuts the paragraph properties PptxGenJS repeats before later runs, and no others", () => {
    const xml = '<a:p><a:pPr marL="1"><a:buChar/></a:pPr><a:r>a</a:r><a:pPr indent="0"><a:buNone/></a:pPr><a:r>b</a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r>c</a:r></a:p>';
    expect(withoutStrayParagraphProps(xml)).toBe('<a:p><a:pPr marL="1"><a:buChar/></a:pPr><a:r>a</a:r><a:r>b</a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r>c</a:r></a:p>');
  });

  it("is a real .pptx: slides, title and bullets as text, notes, and the font names in it", async () => {
    placeElements();
    const pages = pagesOf(SAMPLE);
    const vars = deckVars({ preset: "quiet", accent: "#3f7d6e", scheme: "light" });
    const slides = pages.map((page) => {
      const { container, unmount } = render(<SlideView page={page} layout={layoutOfPage(page, {})} vars={vars} render={slideRenderer([], null)} />);
      const measured = readSlideCanvas(container.querySelector<HTMLElement>(".sv-canvas")!);
      unmount();
      return { measured, notes: notesText(page.notes, (p) => p) };
    });
    const spec = buildDeckSpec({ look: look(), font: "common", slides });
    const blob = await writePptx(spec, { title: "期末專題" });
    const zip = await JSZip.loadAsync(await new Response(blob).arrayBuffer());
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slideFiles).toHaveLength(4);
    const second = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(second).toContain("為什麼要做");
    expect(second).toContain("上課問問題的人很少");
    expect(second).toMatch(/<a:buChar/); // a real bullet
    expect(second).toContain('typeface="Microsoft JhengHei"');
    expect(second).toContain('type="title"'); // in the master's title placeholder
    const notes = await zip.file("ppt/notesSlides/notesSlide2.xml")!.async("string");
    expect(notes).toContain("這段是講稿。");
    const presentation = await zip.file("ppt/presentation.xml")!.async("string");
    expect(second).not.toMatch(/<\/a:r><a:pPr/); // a paragraph's properties once, first
    expect(presentation).toMatch(/sldSz cx="12191695"|sldSz cx="12192000"/);
  });
});
