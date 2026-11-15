import { afterEach, describe, expect, it, vi } from "vitest";
import type { PictureItem } from "./measured";
import { rasterizePictures } from "./rasterize";

afterEach(() => vi.restoreAllMocks());

// jsdom has no canvas: a stand-in that remembers its size and answers toDataURL with a length chosen by the test.
function fakeCanvas(sizes: { png: number; jpeg: number }, opaque = true) {
  const made: { w: number; h: number; drew: unknown[][] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const record = { w: this.width, h: this.height, drew: [] as unknown[][] };
    made.push(record);
    return { drawImage: (...args: unknown[]) => record.drew.push(args), fillRect() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(opaque ? 255 : 0) }), set globalCompositeOperation(_v: string) {}, set fillStyle(_v: string) {} } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation((type?: string) => `data:${type};base64,${"A".repeat(type === "image/jpeg" ? sizes.jpeg : sizes.png)}`);
  return made;
}

function picture(over: { src?: string; natural?: [number, number]; box?: { w: number; h: number }; fit?: string } = {}): PictureItem {
  const img = document.createElement("img");
  Object.defineProperty(img, "complete", { value: true });
  Object.defineProperty(img, "naturalWidth", { value: (over.natural ?? [800, 400])[0] });
  Object.defineProperty(img, "naturalHeight", { value: (over.natural ?? [800, 400])[1] });
  Object.defineProperty(img, "currentSrc", { value: over.src ?? "/a.png" });
  img.style.objectFit = over.fit ?? "contain";
  document.body.append(img);
  const { w, h } = over.box ?? { w: 400, h: 200 };
  return { kind: "picture", why: "image", box: { x: 0, y: 0, w, h }, alt: "", data: null, source: img };
}

describe("making a slide's pictures", () => {
  it("draws a picture at twice the size it has on the slide, as PNG when that is small", async () => {
    const made = fakeCanvas({ png: 1000, jpeg: 500 });
    const item = picture();
    await rasterizePictures([item]);
    expect(made[0]).toMatchObject({ w: 800, h: 400 });
    expect(item.data).toMatch(/^data:image\/png/);
    expect(item.source).toBeUndefined();
  });

  it("tries JPEG for a big solid PNG and keeps the smaller", async () => {
    fakeCanvas({ png: 900_000, jpeg: 100_000 });
    const big = picture();
    await rasterizePictures([big]);
    expect(big.data).toMatch(/^data:image\/jpeg/);
    fakeCanvas({ png: 900_000, jpeg: 950_000 });
    const worse = picture();
    await rasterizePictures([worse]);
    expect(worse.data).toMatch(/^data:image\/png/);
  });

  it("keeps a big PNG with transparency as PNG (a JPEG would put a white box behind it)", async () => {
    fakeCanvas({ png: 900_000, jpeg: 100_000 }, false);
    const logo = picture();
    await rasterizePictures([logo]);
    expect(logo.data).toMatch(/^data:image\/png/);
  });

  it("sends a JPEG photograph straight to JPEG, without making the PNG first", async () => {
    fakeCanvas({ png: 5_000_000, jpeg: 400 });
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    for (const src of ["data:image/jpeg;base64,xx", "/media/photo.JPG?x=1"]) {
      toDataURL.mockClear();
      const photo = picture({ src });
      await rasterizePictures([photo]);
      expect(photo.data).toMatch(/^data:image\/jpeg/);
      expect(toDataURL.mock.calls.map((c) => c[0])).toEqual(["image/jpeg"]);
    }
  });

  it("never makes a side longer than 3840 px", async () => {
    const made = fakeCanvas({ png: 10, jpeg: 10 });
    await rasterizePictures([picture({ box: { w: 3000, h: 1500 } })]);
    expect(Math.max(made[0]!.w, made[0]!.h)).toBeLessThanOrEqual(3840);
  });

  it("crops a cover picture to its box from the middle", async () => {
    const made = fakeCanvas({ png: 10, jpeg: 10 });
    await rasterizePictures([picture({ fit: "cover", natural: [1000, 500], box: { w: 100, h: 100 } })]);
    const [, sx, sy, sw, sh] = made[0]!.drew[0]! as number[];
    expect([sx, sy, sw, sh]).toEqual([250, 0, 500, 500]);
  });

  it("leaves a picture it cannot read without data (the file gets a grey box)", async () => {
    fakeCanvas({ png: 10, jpeg: 10 });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => { throw new DOMException("tainted", "SecurityError"); });
    const item = picture();
    await rasterizePictures([item]);
    expect(item.data).toBeNull();
  });

  it("writes a formula that cannot be drawn as its TeX text, and says how many", async () => {
    fakeCanvas({ png: 10, jpeg: 10 });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => { throw new DOMException("tainted", "SecurityError"); }); // Safari: an SVG with HTML in it taints the canvas
    const host = document.createElement("p");
    const katex = document.createElement("span");
    host.append(katex);
    document.body.append(host);
    const items: PictureItem[] = [{ kind: "picture", why: "math", box: { x: 0, y: 0, w: 400, h: 80 }, alt: "x^2", data: null, source: katex }];
    const list = items as unknown as import("./measured").MeasuredItem[];
    const result = await rasterizePictures(list);
    expect(result.formulasAsText).toBe(1);
    expect(list[0]).toMatchObject({ kind: "text", paragraphs: [{ runs: [{ text: "x^2", mono: true }] }] });
  });
});
