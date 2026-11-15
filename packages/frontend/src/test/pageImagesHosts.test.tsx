// 「插入」 on the two surfaces that have it — the handwriting page (a picture on
// the page, under the strokes) and the whiteboard's pen toolbar (an image card
// at the middle of the view) — through the real toolbar, upload hook and layers:
// photo library and camera inputs, the shared upload path, placing, moving and
// resizing with a pen or a finger, deleting, undo, and what a failed upload says.
import { idleBoardHistory } from "./helpers/boardHistory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReactFlowProvider } from "@xyflow/react";
import { decodePageImages } from "@onden/markdown/page-images";
import InkNodeView from "../components/InkNodeView";
import InkToolbar from "../components/InkToolbar";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";

const savePageImages = vi.hoisted(() => vi.fn<(nodeId: string, value: string, base: string | null) => void>());
vi.mock("../lib/data/pageImagesWriter", () => ({ savePageImages }));
const uploadMedia = vi.hoisted(() => vi.fn<(file: Blob, name?: string) => Promise<string>>());
vi.mock("../lib/data/media", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/media")>(), uploadMedia }));
const addToast = vi.hoisted(() => vi.fn());
vi.mock("../lib/appStore", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/appStore")>(), addToast }));
vi.mock("../lib/ink/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ink/store")>()),
  loadInkPage: vi.fn(async () => null),
}));

const FILE = "0123456789abcdef0123456789abcdef.png";
const photo = (name = "week 3.png") => new File(["x"], name, { type: "image/png" });
const input = (kind: "library" | "camera") => document.querySelector(`[data-ink-insert-input="${kind}"]`) as HTMLInputElement;
const choose = (kind: "library" | "camera", ...files: File[]) => act(async () => { fireEvent.change(input(kind), { target: { files } }); });
const saved = (call = savePageImages.mock.calls.length - 1) => decodePageImages(savePageImages.mock.calls[call]![1]).pages.page?.images ?? [];
const box = () => document.querySelector("[data-page-image-box]") as HTMLElement;
const pointer = (el: Element, type: string, x: number, y: number, pointerType = "pen") => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 5, pointerType, button: 0, buttons: 1, clientX: x, clientY: y });
  fireEvent(el, e);
};
const drag = (el: Element, from: [number, number], to: [number, number], pointerType = "pen") => {
  pointer(el, "pointerdown", ...from, pointerType);
  pointer(el, "pointermove", ...to, pointerType);
  pointer(el, "pointerup", ...to, pointerType);
};

/** The browser reading a picture's size: jsdom decodes nothing, so a picture of the given size is "read". */
function stubImageDecoding(size: { width: number; height: number } | "never") {
  class FakeImage {
    naturalWidth = size === "never" ? 0 : size.width;
    naturalHeight = size === "never" ? 0 : size.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_: string) { if (size !== "never") queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = () => "blob:fake";
    static revokeObjectURL = () => {};
  });
}

beforeEach(() => {
  stubImageDecoding({ width: 4000, height: 3000 });
  stubPagesNearScreen();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  savePageImages.mockReset();
  addToast.mockReset();
  uploadMedia.mockReset().mockResolvedValue(`/api/media/${FILE}`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("handwriting page: 插入 a picture", () => {
  const renderInk = () => render(<InkNodeView pageImages={{ nodeId: "note-1", initial: null }} />);

  it("has one Insert button with two choices, the photo library or files and the camera", () => {
    renderInk();
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    const menu = screen.getByRole("menu", { name: "Insert" });
    expect(within(menu).getByText("Picture from photos or files")).toBeTruthy();
    expect(within(menu).getByText("Take a photo")).toBeTruthy();
    // the library takes pictures (several); the camera asks for a photo taken now, with no stream of our own
    expect(input("library").accept).toContain("image/png");
    expect(input("library").multiple).toBe(true);
    expect(input("camera").getAttribute("accept")).toBe("image/*");
    expect(input("camera").getAttribute("capture")).toBe("environment");
    expect(input("camera").multiple).toBe(false);
  });

  it("a chosen picture goes through the shared upload, lands on the page, is selected, and is saved under the page's key", async () => {
    renderInk();
    await choose("library", photo());
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0]![0]).toBeInstanceOf(File);
    await waitFor(() => expect(savePageImages).toHaveBeenCalledTimes(1));
    expect(savePageImages.mock.calls[0]![0]).toBe("note-1");
    expect(savePageImages.mock.calls[0]![2]).toBeNull();
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ src: `/api/media/${FILE}`, alt: "week 3" });
    // shown in the paper, under the ink; the Hand tool is on with the picture selected
    const img = document.querySelector(".pagebook-page [data-page-image] img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`/api/media/${FILE}`);
    expect(document.querySelector('[data-ink-tool="hand"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(box().className).toContain("page-image-box--selected");
    expect(document.querySelectorAll("[data-page-image-handle]")).toHaveLength(4);
  });

  it("the picture keeps the proportions the browser read from the file, at a comfortable width", async () => {
    stubImageDecoding({ width: 3000, height: 6000 });
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.w / saved()[0]!.h).toBeCloseTo(0.5, 3);
    expect(saved()[0]!.w).toBeLessThanOrEqual(360);
  });

  it("a picture the browser cannot read the size of is still inserted (4:3)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubImageDecoding("never");
    renderInk();
    await choose("library", photo());
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    vi.useRealTimers();
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.w / saved()[0]!.h).toBeCloseTo(4 / 3, 3);
  });

  it("the camera takes the same path", async () => {
    renderInk();
    await choose("camera", photo("IMG_0001.jpg"));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.alt).toBe("IMG_0001");
  });

  it("several pictures at once are all placed, none exactly over another", async () => {
    uploadMedia.mockResolvedValueOnce("/api/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png").mockResolvedValueOnce("/api/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png");
    renderInk();
    await choose("library", photo("a.png"), photo("b.png"));
    await waitFor(() => expect(saved()).toHaveLength(2));
    const [a, b] = saved();
    expect(a!.src).toContain("aaaa");
    expect(b!.src).toContain("bbbb");
    expect(a!.x === b!.x && a!.y === b!.y).toBe(false);
  });

  it("a failed upload says why, places nothing, and the others still go", async () => {
    uploadMedia.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(`/api/media/${FILE}`);
    renderInk();
    await choose("library", photo("bad.png"), photo("good.png"));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.alt).toBe("good");
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![1]).toBe("error");
    expect(String(addToast.mock.calls[0]![0])).not.toContain("offline"); // the person's words, not the error's text
  });

  it("a press and drag with a pen moves it, a finger too; one step and one save each", async () => {
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    const start = saved()[0]!;
    savePageImages.mockClear();
    drag(box(), [200, 200], [260, 230], "pen");
    expect(savePageImages).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toMatchObject({ x: start.x + 60, y: start.y + 30, w: start.w, h: start.h });
    drag(box(), [300, 300], [280, 330], "touch"); // a finger works as well as a pen
    expect(savePageImages).toHaveBeenCalledTimes(2);
    expect(saved()[0]).toMatchObject({ x: start.x + 40, y: start.y + 60 });
  });

  it("a corner resizes it and keeps its proportions", async () => {
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    const start = saved()[0]!;
    savePageImages.mockClear();
    const handle = document.querySelector('[data-page-image-handle="se"]')!;
    drag(handle, [0, 0], [60, 40], "touch");
    const now = saved()[0]!;
    expect(now.w).toBeGreaterThan(start.w);
    expect(now.w / now.h).toBeCloseTo(start.w / start.h, 4);
    expect(now.x).toBe(start.x);
  });

  it("Delete removes it; the trash button too", async () => {
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    fireEvent.keyDown(box(), { key: "Delete" });
    expect(saved()).toEqual([]);
    expect(document.querySelector("[data-page-image]")).toBeNull();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete picture" }));
    expect(saved()).toEqual([]);
  });

  it("the arrow keys nudge a focused picture; Esc lets go; an input method's key does nothing", async () => {
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    const start = saved()[0]!;
    fireEvent.keyDown(box(), { key: "ArrowRight" });
    expect(saved()[0]!.x).toBe(start.x + 10);
    savePageImages.mockClear();
    fireEvent.keyDown(box(), { key: "ArrowDown", isComposing: true, keyCode: 229 });
    expect(savePageImages).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().className).not.toContain("selected");
  });

  it("Undo takes back the insertion while the picture is selected, then the move; the pen's undo is the drawing's", async () => {
    renderInk();
    const undo = () => screen.getAllByRole("button").find((b) => b.getAttribute("title")?.startsWith("Undo")) as HTMLButtonElement;
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    drag(box(), [200, 200], [260, 230]);
    const moved = saved()[0]!;
    expect(undo().disabled).toBe(false);
    act(() => { fireEvent.click(undo()); }); // the move
    expect(saved()[0]!.x).toBe(moved.x - 60);
    act(() => { fireEvent.click(undo()); }); // the insertion
    expect(saved()).toEqual([]);
    expect(document.querySelector("[data-page-image]")).toBeNull();
    act(() => { fireEvent.click(screen.getAllByRole("button").find((b) => b.getAttribute("title")?.startsWith("Redo"))!); });
    expect(saved()).toHaveLength(1);
    // with the pen the pictures are not the undo's business (the drawing is empty)
    fireEvent.click(document.querySelector('[data-ink-tool="pen"]')!);
    expect(undo().disabled).toBe(true);
  });

  it("in the pen tool the picture is shown and takes no presses (a stroke goes over it)", async () => {
    renderInk();
    await choose("library", photo());
    await waitFor(() => expect(saved()).toHaveLength(1));
    fireEvent.click(document.querySelector('[data-ink-tool="pen"]')!);
    expect(document.querySelector("[data-page-image]")).toBeTruthy();
    expect(document.querySelector("[data-page-image-box]")).toBeNull(); // no hit box, no handles
    expect(document.querySelector("[data-page-image-handle]")).toBeNull();
  });

  it("the picture is in the paper, under the stage that holds the ink; the handles are over it", () => {
    const css = (file: string) => readFileSync(join(__dirname, file), "utf8");
    const layers = (text: string) => text.replace(/var\(--z-base\)/g, "0").replace(/var\(--z-local-(\d)\)/g, "$1");
    const z = (text: string, selector: string) => Number(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*z-index:\\s*(\\d+)`).exec(layers(text))?.[1]);
    expect(z(css("../components/page/PageImageLayer.css"), ".page-image-layer--art")).toBeLessThan(z(css("../pagebook/PageInk.css"), ".page-ink-surface"));
    expect(z(css("../components/page/PageImageLayer.css"), ".page-image-layer--controls")).toBeGreaterThan(z(css("../pagebook/PageInk.css"), ".page-ink-surface"));
  });

  it("a picture that cannot be loaded shows a quiet placeholder with its name, not a broken icon", async () => {
    render(<InkNodeView pageImages={{ nodeId: "n", initial: JSON.stringify({ v: 1, pages: { page: { images: [{ id: "a", x: 0, y: 0, w: 300, h: 200, src: `/api/media/${FILE}`, alt: "diagram", updated_at: "" }] } } }) }} />);
    fireEvent.error(document.querySelector("[data-page-image] img")!);
    expect(document.querySelector("[data-page-image] img")).toBeNull();
    expect(screen.getByText("diagram")).toBeTruthy();
  });

  it("a picture below the ink keeps the page that tall when the note opens again, so it is not cut off", async () => {
    render(<InkNodeView pageImages={{ nodeId: "n", initial: JSON.stringify({ v: 1, pages: { page: { images: [{ id: "a", x: 100, y: 1800, w: 300, h: 300, src: `/api/media/${FILE}`, alt: "", updated_at: "" }] } } }) }} />);
    // The sheet is as tall as the picture's bottom (2100 units) says: its box has the page's ratio.
    await waitFor(() => {
      const box = document.querySelector<HTMLElement>(".pagebook-page")!;
      expect(parseFloat(box.style.getPropertyValue("--pagebook-h")) / parseFloat(box.style.getPropertyValue("--pagebook-w"))).toBeGreaterThanOrEqual(2.1);
    });
  });

  it("a note written by a newer version shows its pictures but cannot be changed", () => {
    render(<InkNodeView readOnly pageImages={{ nodeId: "n", initial: JSON.stringify({ v: 2, pages: { page: { images: [{ id: "a", x: 0, y: 0, w: 300, h: 200, src: `/api/media/${FILE}`, alt: "", updated_at: "" }] } } }) }} />);
    expect(document.querySelector("[data-page-image] img")).toBeTruthy();
    expect(document.querySelector("[data-page-image-box]")).toBeNull();
    expect(document.querySelector("[data-ink-insert]")).toBeNull();
  });

  it("a page without a picture layer (no source) has no Insert button", () => {
    render(<InkNodeView />);
    expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  });
});

describe("the toolbar", () => {
  const base = { tool: "pen" as const, onToolChange: () => {}, color: "#15130d", onColorChange: () => {}, sizeId: "medium", onSizeChange: () => {}, canUndo: false, canRedo: false, onUndo: () => {}, onRedo: () => {} };

  it("has no Insert button unless the host can place pictures (the PDF passes none)", () => {
    const { rerender } = render(<InkToolbar {...base} />);
    expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
    rerender(<InkToolbar {...base} insert={{ onFiles: () => {} }} />);
    expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy();
    rerender(<InkToolbar {...base} readOnly insert={{ onFiles: () => {} }} />);
    expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  });

  it("says it is uploading while the host works", () => {
    render(<InkToolbar {...base} insert={{ onFiles: () => {}, busy: true }} />);
    expect(screen.getByRole("button", { name: "Uploading…" }).getAttribute("aria-busy")).toBe("true");
  });

  it("the source of the PDF toolbar passes no insert", () => {
    expect(readFileSync(join(__dirname, "../components/PdfNodeView.tsx"), "utf8")).not.toMatch(/insert=\{/);
  });
});

describe("whiteboard pen toolbar: 插入 a picture", () => {
  async function mountLayer(onInsertImages: (files: File[], at: { x: number; y: number }) => Promise<void>) {
    const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
    function Host() {
      const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
      return (
        <ReactFlowProvider>
          <CanvasInkLayer boardHistory={idleBoardHistory} canvasId="c1" penActive spaceHeld={false} pen={pen} onInsertImages={onInsertImages} />
        </ReactFlowProvider>
      );
    }
    return render(<Host />);
  }

  it("hands the chosen pictures to the board's own upload-and-place, at the middle of the view, and shows it is busy until placed", async () => {
    let finish!: () => void;
    const onInsert = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mountLayer(onInsert);
    await choose("library", photo());
    expect(onInsert).toHaveBeenCalledTimes(1);
    const [files, at] = onInsert.mock.calls[0] as unknown as [File[], { x: number; y: number }];
    expect(files).toHaveLength(1);
    expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
    expect(screen.getByRole("button", { name: "Uploading…" })).toBeTruthy();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy());
    expect(uploadMedia).not.toHaveBeenCalled(); // the board's action uploads, not the layer
  });

  it("the camera works there too", async () => {
    const onInsert = vi.fn(async () => {});
    await mountLayer(onInsert);
    await choose("camera", photo("cam.jpg"));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });
});
