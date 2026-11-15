// 「分享 → Onden」: what another app shares becomes the quick-capture draft
// (lib/share/sharePayload.ts) — a link, text, images, several at once.
import { describe, expect, it } from "vitest";
import {
  asUploadableImage, draftWithTitle, fileFromNative, findUrl, mergeShares, parseSharePayload, rawShareFromForm,
} from "../lib/share/sharePayload";

const image = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

describe("findUrl", () => {
  it("finds the first http(s) URL and drops sentence punctuation after it", () => {
    expect(findUrl("Read this https://example.com/a?b=1.")).toBe("https://example.com/a?b=1");
    expect(findUrl("看這篇：https://example.com/文章。")).toBe("https://example.com/文章");
    expect(findUrl("(https://example.com/x)")).toBe("https://example.com/x");
    expect(findUrl("no link here")).toBeNull();
    expect(findUrl("ftp://example.com")).toBeNull();
    expect(findUrl(null)).toBeNull();
  });
});

describe("parseSharePayload", () => {
  it("a shared link: its title on the first line, then the URL", () => {
    expect(parseSharePayload({ title: "A page", url: "https://example.com/p" }))
      .toEqual({ url: "https://example.com/p", draft: "A page\nhttps://example.com/p", images: [], skipped: [] });
  });

  it("a link with no title is the URL alone", () => {
    expect(parseSharePayload({ url: "https://example.com/p" }).draft).toBe("https://example.com/p");
  });

  it("Android: the link inside EXTRA_TEXT is found, and said once", () => {
    const share = parseSharePayload({ title: "Article", text: "Article https://example.com/p" });
    expect(share.url).toBe("https://example.com/p");
    expect(share.draft).toBe("Article\nhttps://example.com/p");
  });

  it("keeps other shared words after the link", () => {
    const share = parseSharePayload({ text: "Look at this: https://example.com/p so good", url: "https://example.com/p" });
    expect(share.draft).toBe("https://example.com/p\n\nLook at this: so good");
  });

  it("plain text is the text itself, line breaks normalised", () => {
    expect(parseSharePayload({ text: "  line one\r\nline two  " }))
      .toEqual({ url: null, draft: "line one\nline two", images: [], skipped: [] });
  });

  it("a subject with text and no link: the subject above the text", () => {
    expect(parseSharePayload({ title: "Subject", text: "Body" }).draft).toBe("Subject\nBody");
  });

  it("images: kept for upload, unnamed ones named from their type, refused types listed", () => {
    const share = parseSharePayload({
      files: [image("photo.jpg", "image/jpeg"), image("1000034", "image/png"), image("IMG.HEIC", "image/heic"), image("doc.bin", "application/octet-stream")],
    });
    expect(share.draft).toBe("");
    expect(share.images.map((f) => f.name)).toEqual(["photo.jpg", "1000034.png"]);
    expect(share.images[1]!.type).toBe("image/png");
    expect(share.skipped).toEqual(["IMG.HEIC", "doc.bin"]);
  });

  it("images with a caption keep both", () => {
    const share = parseSharePayload({ text: "Whiteboard", files: [image("a.png", "image/png"), image("b.webp", "image/webp")] });
    expect(share.draft).toBe("Whiteboard");
    expect(share.images).toHaveLength(2);
  });
});

describe("asUploadableImage", () => {
  it("keeps a named image as it is and gives an unnamed one a stem", () => {
    const named = image("x.gif", "image/gif");
    expect(asUploadableImage(named, 0)).toBe(named);
    expect(asUploadableImage(image("", "image/jpeg"), 2)?.name).toBe("shared-3.jpg");
  });
});

describe("mergeShares", () => {
  it("joins several shares into one capture", () => {
    const a = parseSharePayload({ url: "https://a.example/" });
    const b = parseSharePayload({ text: "second", files: [image("p.png", "image/png")] });
    expect(mergeShares([a, b])).toEqual({ url: "https://a.example/", draft: "https://a.example/\n\nsecond", images: b.images, skipped: [] });
    expect(mergeShares([])).toBeNull();
    expect(mergeShares([a])).toBe(a);
  });
});

describe("draftWithTitle", () => {
  it("puts the fetched page title above a bare URL", () => {
    const share = parseSharePayload({ url: "https://example.com/p" });
    expect(draftWithTitle(share, "  The Real Title ")).toBe("The Real Title\nhttps://example.com/p");
  });

  it("replaces a shared title and keeps the words after the link", () => {
    const share = parseSharePayload({ title: "Site", text: "note https://example.com/p" });
    expect(draftWithTitle(share, "Page title")).toBe("Page title\nhttps://example.com/p\n\nnote");
  });

  it("leaves the draft alone with no title or no link", () => {
    const link = parseSharePayload({ url: "https://example.com/p" });
    expect(draftWithTitle(link, null)).toBe(link.draft);
    expect(draftWithTitle(link, "https://example.com/p")).toBe(link.draft);
    const text = parseSharePayload({ text: "hi" });
    expect(draftWithTitle(text, "Title")).toBe("hi");
  });
});

describe("raw shares from each source", () => {
  it("reads a Web Share Target form: fields and every `images` file", () => {
    const form = new FormData();
    form.set("title", "T");
    form.set("text", "https://example.com");
    form.append("images", image("a.png", "image/png"));
    form.append("images", image("b.png", "image/png"));
    form.append("images", new File([], "empty.png", { type: "image/png" }));
    const raw = rawShareFromForm(form);
    expect(raw).toMatchObject({ title: "T", text: "https://example.com", url: null });
    expect(raw.files!.map((f) => f.name)).toEqual(["a.png", "b.png"]);
  });

  it("decodes an Android plugin file (base64)", async () => {
    const file = fileFromNative({ name: null, mimeType: "image/png", data: btoa("abc") }, 0);
    expect(file.name).toBe("shared-1");
    expect(file.type).toBe("image/png");
    expect(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))).toBe("abc");
  });
});
