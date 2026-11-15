import { describe, expect, it } from "vitest";
import { firstMedia } from "./routes.js";

describe("firstMedia", () => {
  it("finds a video or audio file, directly or in a <source>", () => {
    expect(firstMedia('<p>x</p><video controls src="https://cdn.test/a.mp4"></video>')).toEqual({ kind: "video", url: "https://cdn.test/a.mp4" });
    expect(firstMedia('<audio controls><source src="https://cdn.test/a.mp3" type="audio/mpeg"></audio>')).toEqual({ kind: "audio", url: "https://cdn.test/a.mp3" });
  });
  it("finds a YouTube or Vimeo player link as an embed", () => {
    expect(firstMedia('<p><a href="https://www.youtube.com/watch?v=abc123">v</a></p>')?.kind).toBe("embed");
    expect(firstMedia("https://player.vimeo.com/video/123")?.kind).toBe("embed");
  });
  it("is null for plain text, pictures and relative files", () => {
    expect(firstMedia('<img src="https://x.test/a.png"><video src="/rel.mp4"></video>')).toBeNull();
    expect(firstMedia("")).toBeNull();
  });
});
