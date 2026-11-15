import { describe, it, expect } from "vitest";
import { mediaOnlyCard } from "../lib/cardBody";

describe("mediaOnlyCard", () => {
  it("detects a body that is exactly one image", () => {
    expect(mediaOnlyCard("![a cat](https://x/cat.png)")).toEqual({ kind: "image", url: "https://x/cat.png", alt: "a cat" });
    expect(mediaOnlyCard("  ![](/media/abc.jpg)\n")).toEqual({ kind: "image", url: "/media/abc.jpg", alt: "" });
  });

  it("drops an optional markdown title, keeping just the url", () => {
    expect(mediaOnlyCard('![t](https://x/p.png "the title")')?.url).toBe("https://x/p.png");
  });

  it("returns null when the body is more than just an image", () => {
    expect(mediaOnlyCard("# Heading\n\n![](x.png)")).toBeNull();   // image + text
    expect(mediaOnlyCard("![](a.png) ![](b.png)")).toBeNull();      // two images
    expect(mediaOnlyCard("see ![](x.png)")).toBeNull();             // leading text
    expect(mediaOnlyCard("just prose")).toBeNull();
    expect(mediaOnlyCard("https://example.com")).toBeNull();        // a bare url, not an image
    expect(mediaOnlyCard("")).toBeNull();
  });

  // D35: the sidebar's audio/video notes are `![name](/api/media/x.mp3)`; the
  // card drew every such body as an <img> — a broken picture on the board.
  it("makes a single audio/video file a player card, not an image", () => {
    expect(mediaOnlyCard("![lecture](/api/media/0123abcd.mp3)\n")).toEqual({ kind: "audio", url: "/api/media/0123abcd.mp3", alt: "lecture" });
    expect(mediaOnlyCard("![clip](/api/media/0123abcd.webm)")?.kind).toBe("video");
    expect(mediaOnlyCard("![](/api/media/a.oga)")?.kind).toBe("audio");
    expect(mediaOnlyCard("![](https://cdn.example/a.MOV?x=1)")?.kind).toBe("video");
  });

  it("is not a media card for a known non-image file, and stays an image for an extensionless URL", () => {
    expect(mediaOnlyCard("![paper](/api/media/a.pdf)")).toBeNull();
    expect(mediaOnlyCard("![](/api/media/a.docx)")).toBeNull();
    expect(mediaOnlyCard("![](https://images.example/photo-123?w=800)")?.kind).toBe("image");
    expect(mediaOnlyCard("![](/api/media/favicon.ico)")?.kind).toBe("image");
  });
});
