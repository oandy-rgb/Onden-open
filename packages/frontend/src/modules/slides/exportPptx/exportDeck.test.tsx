import { cleanup, render } from "@testing-library/react";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deckVars } from "@onden/site/look";
import { layoutOfPage, pagesOf } from "../pages";
import SlideView from "../SlideView";
import { slideRenderer } from "../slideRender";
import { exportDeck, type Stage } from "./exportDeck";
import { masterLookOf } from "./look";
import { placeElements } from "./testkit";
import { ExportCancelled } from "./writePptx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const style = { preset: "quiet", accent: "#3f7d6e", scheme: "light" } as const;
const vars = deckVars(style);
const pages = pagesOf("# 標題\n副標\n\n---\n\n## 第二頁\n- 一\n- 二\n\n這是講稿。\n\n---\n\n## 第三頁\n- 三");

// The stage the dialog provides, here a SlideView drawn in the test's DOM.
function stageOf(): Stage {
  return {
    show: async (index) => {
      const { container } = render(<SlideView page={pages[index]!} layout={layoutOfPage(pages[index]!, {})} vars={vars} render={slideRenderer([], null)} />);
      return container.querySelector<HTMLElement>(".sv-canvas")!;
    },
  };
}

describe("exportDeck", () => {
  it("makes a .pptx with a slide for each page, their words and the speaker notes, and reports progress", async () => {
    placeElements();
    const progress: number[] = [];
    const result = await exportDeck({
      pages, stage: stageOf(), look: masterLookOf(style, vars), font: "noto", title: "測試", signal: new AbortController().signal,
      onProgress: (done, total) => { expect(total).toBe(3); progress.push(done); },
    });
    expect(progress).toEqual([1, 2, 3]);
    expect(result.missingPictures).toEqual([]);
    const zip = await JSZip.loadAsync(await new Response(result.blob).arrayBuffer());
    expect(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))).toHaveLength(3);
    const second = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(second).toContain("第二頁");
    expect(second).toContain('typeface="Noto Sans TC"');
    expect(await zip.file("ppt/notesSlides/notesSlide2.xml")!.async("string")).toContain("這是講稿。");
  });

  it("stops between pages when cancelled, with no file", async () => {
    placeElements();
    const controller = new AbortController();
    const stage = stageOf();
    await expect(exportDeck({
      pages, stage: { show: async (i) => { const canvas = await stage.show(i); controller.abort(); return canvas; } }, look: masterLookOf(style, vars),
      font: "common", title: "x", signal: controller.signal, onProgress: () => {},
    })).rejects.toBeInstanceOf(ExportCancelled);
  });
});
