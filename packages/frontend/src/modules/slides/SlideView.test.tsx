import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deckVars } from "@onden/site/look";
import SlideView from "./SlideView";
import { slideRenderer } from "./slideRender";
import { LAYOUT_IDS, pagesOf } from "./pages";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const vars = deckVars({ preset: "quiet", accent: "#3f7d6e", scheme: "light" });
const renderMd = (md: string) => <div data-md="">{md}</div>;
const RICH = "## Rich page\n\nSay this aloud.\n\n![pic](a.png)\n\n- 90% of users stay\n- 2025 grow\n- 3x faster\n\n> a quote\n\n```ts\nx\n```";

describe("a slide", () => {
  it("draws any page in any of the twelve layouts, with the title as a heading", () => {
    const [page] = pagesOf(RICH);
    for (const layout of LAYOUT_IDS) {
      const { container, unmount } = render(<SlideView page={page} layout={layout} vars={vars} render={renderMd} />);
      expect(container.querySelector(".sv-canvas")?.getAttribute("data-layout")).toBe(layout);
      expect(container.textContent).toContain("Rich page");
      unmount();
    }
  });

  it("draws plain lines as a bulleted list in Bullets, and keeps them plain text in Paragraphs", () => {
    const [page] = pagesOf("## T\n\n- one\n- two\n- three");
    const bullets = render(<SlideView page={{ ...page, parts: { ...page.parts, body: [{ kind: "paragraph", markdown: "one\ntwo\nthree" }] } }} layout="bullets" vars={vars} render={renderMd} />);
    expect(bullets.container.querySelector("[data-md]")?.textContent).toBe("- one\n- two\n- three");
    expect(bullets.container.querySelector(".sv-canvas")?.classList.contains("sv-l-bullets")).toBe(true);
    bullets.unmount();
    const text = render(<SlideView page={{ ...page, parts: { ...page.parts, body: [{ kind: "paragraph", markdown: "one\ntwo\nthree" }] } }} layout="text" vars={vars} render={renderMd} />);
    expect(text.container.querySelector("[data-md]")?.textContent).toBe("one\ntwo\nthree");
    expect(text.container.querySelector(".sv-body")?.classList.contains("sv-measure")).toBe(true);
  });

  it("keeps bold and links when Bullets turns plain lines into a list", () => {
    const [page] = pagesOf("## T\n\n- x");
    const body = [{ kind: "paragraph" as const, markdown: "A **bold** line\nSee [[Other note]]" }];
    const { container } = render(<SlideView page={{ ...page, parts: { ...page.parts, body } }} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.querySelector("[data-md]")?.textContent).toBe("- A **bold** line\n- See [[Other note]]");
  });

  it("keeps the speaker's paragraphs off the slide", () => {
    const [page] = pagesOf("## T\n\nFor the speaker only.\n\n- shown");
    const { container } = render(<SlideView page={page} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.textContent).toContain("shown");
    expect(container.textContent).not.toContain("For the speaker only");
  });

  it("wears the deck's variables on its canvas", () => {
    const [page] = pagesOf("## T\n- a");
    const { container } = render(<SlideView page={page} layout="bullets" vars={vars} render={renderMd} />);
    const canvas = container.querySelector<HTMLElement>(".sv-canvas")!;
    expect(canvas.style.getPropertyValue("--s-base")).toBe("43px");
    expect(canvas.style.getPropertyValue("--s-bg")).toBe(vars["--s-bg"]);
  });
});

describe("放不下", () => {
  const body = (el: HTMLElement) => (el.classList.contains("sv-fit") ? el : null);
  function crowd(heightFits: (el: HTMLElement) => boolean) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return body(this) ? 2000 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return body(this) ? (heightFits(this) ? 5000 : 100) : 0; });
  }
  const [page] = pagesOf("## T\n- a\n- b");

  it("step one: a crowded body goes one level smaller, and says so", () => {
    crowd((el) => !!el.closest(".sv-shrunk"));
    const onFit = vi.fn();
    const { container } = render(<SlideView page={page} layout="bullets" vars={vars} render={renderMd} onFit={onFit} />);
    expect(container.querySelector(".sv-canvas")?.classList.contains("sv-shrunk")).toBe(true);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: false });
  });

  it("when one level is not enough it reports the overflow and keeps every word", () => {
    crowd(() => false);
    const onFit = vi.fn();
    const { container } = render(<SlideView page={page} layout="bullets" vars={vars} render={renderMd} onFit={onFit} />);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
    expect(container.textContent).toContain("a");
  });

  it("a slide that fits is left alone", () => {
    const onFit = vi.fn();
    const { container } = render(<SlideView page={page} layout="bullets" vars={vars} render={renderMd} onFit={onFit} />);
    expect(container.querySelector(".sv-canvas")?.classList.contains("sv-shrunk")).toBe(false);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: false, overflow: false });
  });
});

describe("撐開版面 (the mirror of 放不下)", () => {
  const few = pagesOf("## T\n- a\n- b\n- c")[0];
  const many = pagesOf(`## T\n${Array.from({ length: 9 }, (_, i) => `- point number ${i} with some words`).join("\n")}`)[0];

  it("a slide with three short lines starts two levels up and centred", () => {
    const { container } = render(<SlideView page={few} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.querySelector(".sv-body")?.classList.contains("sv-grow-2")).toBe(true);
  });

  it("a full slide is drawn at the body size", () => {
    const { container } = render(<SlideView page={many} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.querySelector(".sv-grow")).toBeNull();
  });

  it("a layout that sets its own size is not grown", () => {
    const { container } = render(<SlideView page={few} layout="timeline" vars={vars} render={renderMd} />);
    expect(container.querySelector(".sv-grow")).toBeNull();
  });

  it("a grown slide that does not fit steps back one level at a time, before 放不下 shrinks it", () => {
    const sizes: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("sv-fit")) return 0;
      sizes.push(this.className.match(/sv-grow-\d/)?.[0] ?? (this.closest(".sv-shrunk") ? "shrunk" : "body"));
      return 2000;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") ? 100 : 0; });
    const onFit = vi.fn();
    render(<SlideView page={few} layout="bullets" vars={vars} render={renderMd} onFit={onFit} />);
    expect([...new Set(sizes)]).toEqual(["sv-grow-2", "sv-grow-1", "body", "shrunk"]);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
  });
});

describe("no raw Markdown on a slide", () => {
  const text = (md: string, layout: "stat" | "timeline") => {
    const [page] = pagesOf(md);
    const { container } = render(<SlideView page={page} layout={layout} vars={vars} render={renderMd} />);
    return container.textContent ?? "";
  };

  it("Numbers shows the words of each item", () => {
    const shown = text("## T\n- **90%** of [[Users|people]] stay\n- [ ] 3x faster", "stat");
    expect(shown).toContain("90%");
    expect(shown).toContain("of people stay");
    for (const raw of ["**", "[[", "]]", "[ ]"]) expect(shown).not.toContain(raw);
  });

  it("Steps shows the words of each item", () => {
    const shown = text("## T\n- **2024** [[Start]]\n- 2025 *grow*\n- 2026 `ship`", "timeline");
    expect(shown).toContain("Start");
    expect(shown).toContain("grow");
    for (const raw of ["**", "[[", "*grow*", "`"]) expect(shown).not.toContain(raw);
  });
});

describe("a long cover or section line", () => {
  const crowdCentre = () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") ? 2000 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") ? 100 : 0; });
  };
  const [page] = pagesOf("# Title\n\nA subtitle");

  it("is measured like any other text: the centred block steps down and reports when it still does not fit", () => {
    crowdCentre();
    const onFit = vi.fn();
    const { container } = render(<SlideView page={page} layout="cover" vars={vars} render={renderMd} onFit={onFit} />);
    expect(container.querySelector(".sv-center")?.classList.contains("sv-fit")).toBe(true);
    expect(container.querySelector(".sv-canvas")?.classList.contains("sv-shrunk")).toBe(true);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
  });

  it("a section slide is measured the same way", () => {
    crowdCentre();
    const onFit = vi.fn();
    render(<SlideView page={page} layout="section" vars={vars} render={renderMd} onFit={onFit} />);
    expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
  });
});

describe("a slide whose words change", () => {
  it("is measured again (not left shrunk) when the text is cut, even if the number of blocks stays", () => {
    const crowded = pagesOf("## T\n- " + "word ".repeat(80))[0];
    const short = pagesOf("## T\n- ok")[0];
    // Too full only while the long text is on the slide.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sv-fit") && this.textContent!.length > 100 ? 2000 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") ? 100 : 0; });
    const { container, rerender } = render(<SlideView page={{ ...crowded, key: "same" }} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.querySelector(".sv-canvas")?.classList.contains("sv-shrunk")).toBe(true);
    rerender(<SlideView page={{ ...short, key: "same" }} layout="bullets" vars={vars} render={renderMd} />);
    expect(container.querySelector(".sv-canvas")?.classList.contains("sv-shrunk")).toBe(false);
  });
});

describe("a table on a slide", () => {
  const TABLE = "| 原因 | Lexis | Westlaw | Practical Law |\n| --- | --- | --- | --- |\n| 檢索太天真 | 47% | 20% | 34% |\n| 引用不適用的法源 | 38% | 23% | 34% |";
  const LONG = `${"這是一個很長很長很長的儲存格，裡面有一整句話。".repeat(2)}`;
  const tablePage = (md: string) => pagesOf(`## 各類原因的占比\n\n${md}`)[0]!;
  const realRender = (markdown: string) => slideRenderer([], null)(markdown);
  const draw = (md: string, layout: "text" | "bullets" = "text", onFit?: () => void) =>
    render(<SlideView page={tablePage(md)} layout={layout} vars={vars} render={realRender} onFit={onFit} />);

  it("takes the whole width: a table-only page is a paragraph page without the paragraph's line length", () => {
    const { container } = draw(TABLE);
    const body = container.querySelector(".sv-body")!;
    expect(body.classList.contains("sv-has-table")).toBe(true);
    expect(body.classList.contains("sv-measure")).toBe(false);
  });

  it("keeps a plain paragraph page at its comfortable line length", () => {
    const [page] = pagesOf("## T\n\n> a quote");
    const { container } = render(<SlideView page={page!} layout="text" vars={vars} render={realRender} />);
    expect(container.querySelector(".sv-body")?.classList.contains("sv-measure")).toBe(true);
  });

  it("does not run a table's page in two columns, even with more than six list items next to it", () => {
    const items = Array.from({ length: 8 }, (_, i) => `- point ${i}`).join("\n");
    const { container } = draw(`${TABLE}\n\n${items}`, "bullets");
    expect(container.querySelector(".sv-body")?.classList.contains("sv-two")).toBe(false);
  });

  it("never wraps a short cell, and lets only a long sentence wrap", () => {
    const { container } = draw(`| 原因 | 說明 |\n| --- | --- |\n| 檢索太天真 | ${LONG} |`);
    const cells = [...container.querySelectorAll("th, td")].map((c) => [c.textContent, c.classList.contains("sv-nowrap")]);
    expect(cells).toEqual([["原因", true], ["說明", true], ["檢索太天真", true], [LONG, false]]);
  });

  it("keeps the alignment the note marks, and leaves the rest alone", () => {
    const { container } = draw("| a | b | c |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |");
    expect([...container.querySelectorAll("td")].map((c) => (c as HTMLElement).style.textAlign)).toEqual(["left", "right", "center"]);
  });

  it("measures again once a slide that was not drawn yet (the player's closed dialog) has a size", () => {
    let width = 0;
    let resize: () => void = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-frame") ? width : 100; });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") && width > 0 ? 5000 : 100; });
    const { container } = draw(TABLE);
    const canvas = container.querySelector<HTMLElement>(".sv-canvas")!;
    expect(canvas.classList.contains("sv-shrunk")).toBe(false);
    width = 640;
    act(() => resize());
    expect(canvas.classList.contains("sv-shrunk-2")).toBe(true);
    vi.unstubAllGlobals();
  });

  describe("when it is too big", () => {
    const squeeze = (fitsAt: (canvas: HTMLElement) => boolean) => {
      const crowded = function (this: HTMLElement) { return this.classList.contains("sv-fit") && !fitsAt(this.closest(".sv-canvas") as HTMLElement); };
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return crowded.call(this) ? 5000 : 100; });
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => 100);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 100);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 100);
    };
    const has = (c: HTMLElement, name: string) => c.classList.contains(name);

    it("shrinks the whole table one level, and stops there when that fits", () => {
      squeeze((c) => has(c, "sv-shrunk"));
      const onFit = vi.fn();
      const { container } = draw(TABLE, "text", onFit);
      const canvas = container.querySelector<HTMLElement>(".sv-canvas")!;
      expect(has(canvas, "sv-shrunk")).toBe(true);
      expect(has(canvas, "sv-shrunk-2")).toBe(false);
      expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: false });
    });

    it("goes down to the smallest readable size when it must, and reports it only if it still does not fit", () => {
      squeeze((c) => has(c, "sv-shrunk-2"));
      const fits = vi.fn();
      const a = draw(TABLE, "text", fits);
      expect(has(a.container.querySelector<HTMLElement>(".sv-canvas")!, "sv-shrunk-2")).toBe(true);
      expect(fits).toHaveBeenLastCalledWith({ shrunk: true, overflow: false });
      a.unmount();
      vi.restoreAllMocks();
      squeeze(() => false);
      const gone = vi.fn();
      const b = draw(TABLE, "text", gone);
      expect(has(b.container.querySelector<HTMLElement>(".sv-canvas")!, "sv-shrunk-2")).toBe(true);
      expect(gone).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
      expect(b.container.textContent).toContain("引用不適用的法源");
    });

    it("last of all, a table still too wide at the smallest size lets its short cells wrap", () => {
      // Too wide only while a short cell is held on one line.
      squeeze((c) => has(c, "sv-shrunk-2") && !c.querySelector(".sv-nowrap"));
      const onFit = vi.fn();
      const { container } = draw(TABLE, "text", onFit);
      expect(container.querySelectorAll(".sv-nowrap")).toHaveLength(0);
      expect(has(container.querySelector<HTMLElement>(".sv-canvas")!, "sv-shrunk-2")).toBe(true);
      expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: false });
    });

    it("a table that is only too TALL never lets its short cells wrap (it cannot help)", () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("sv-fit") ? 5000 : 100; });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 100);
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => 100);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 100);
      const onFit = vi.fn();
      const { container } = draw(TABLE, "text", onFit);
      const canvas = container.querySelector<HTMLElement>(".sv-canvas")!;
      expect(container.querySelectorAll(".sv-nowrap").length).toBeGreaterThan(0);
      expect(canvas.dataset.relax).toBeUndefined();
      expect(onFit).toHaveBeenLastCalledWith({ shrunk: true, overflow: true });
    });

    it("steps the relaxing in order: short cells wrap first, a word without a break point breaks only after that", () => {
      const seen: string[] = [];
      squeeze((c) => { seen.push(c.dataset.relax ?? "0"); return c.dataset.relax === "2"; });
      const { container } = draw(TABLE, "text");
      expect([...new Set(seen)]).toEqual(["0", "1", "2"]);
      expect(container.querySelector<HTMLElement>(".sv-canvas")!.dataset.relax).toBe("2");
    });

    it("a table that fits by shrinking keeps its short cells on one line", () => {
      squeeze((c) => has(c, "sv-shrunk-2") && !!c.querySelector(".sv-nowrap"));
      const { container } = draw(TABLE, "text");
      expect(container.querySelectorAll(".sv-nowrap").length).toBeGreaterThan(0);
    });

    it("a page without a table has one level only", () => {
      squeeze(() => false);
      const { container } = render(<SlideView page={pagesOf("## T\n- a\n- b")[0]!} layout="bullets" vars={vars} render={renderMd} />);
      expect(container.querySelector(".sv-shrunk-2")).toBeNull();
    });
  });
});
