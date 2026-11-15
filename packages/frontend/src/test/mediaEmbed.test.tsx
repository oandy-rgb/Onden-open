// media-embed: the MarkdownRenderer (app and published profiles)
// renders mp4/webm/mp3 file URLs and YouTube/Vimeo embeds, while the sanitizer
// boundary stays safe (untrusted iframe hosts are dropped, embeds are
// sandboxed). Covers the renderer + the unit-level host gate.

import { describe, it, expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { isAllowedEmbedSrc, toEmbedUrl, classifyMedia, EMBED_IFRAME_SANDBOX } from "@onden/markdown";

describe("mediaEmbed helpers (the sanitizer host gate)", () => {
  it("only trusts YouTube/Vimeo https hosts; rejects everything else", () => {
    expect(isAllowedEmbedSrc("https://www.youtube.com/embed/abc123")).toBe(true);
    expect(isAllowedEmbedSrc("https://www.youtube-nocookie.com/embed/abc123")).toBe(true);
    expect(isAllowedEmbedSrc("https://player.vimeo.com/video/12345")).toBe(true);
    // untrusted host — the XSS surface an unrestricted iframe would open
    expect(isAllowedEmbedSrc("https://evil.example/embed")).toBe(false);
    // a host that merely CONTAINS the trusted name but isn't a subdomain
    expect(isAllowedEmbedSrc("https://youtube.com.evil.example/x")).toBe(false);
    // non-https schemes are rejected (no javascript:, no http:)
    expect(isAllowedEmbedSrc("http://www.youtube.com/embed/abc")).toBe(false);
    expect(isAllowedEmbedSrc("javascript:alert(1)//youtube.com")).toBe(false);
    expect(isAllowedEmbedSrc("")).toBe(false);
    expect(isAllowedEmbedSrc(undefined)).toBe(false);
  });

  it("normalises watch/share URLs to a sandbox-friendly embed URL", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
      .toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ"))
      .toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://vimeo.com/76979871"))
      .toBe("https://player.vimeo.com/video/76979871");
    expect(toEmbedUrl("https://evil.example/watch?v=x")).toBeNull();
  });

  it("SECURITY: the iframe sandbox grants scripts but NEVER allow-same-origin", () => {
    const flags = EMBED_IFRAME_SANDBOX.split(/\s+/);
    // allow-same-origin + allow-scripts together would let a framed third-party
    // player escape the sandbox (reach its own origin's cookies/storage and run
    // script): the two combined defeat the sandbox. We grant scripts (players
    // need them) but must withhold same-origin.
    expect(flags).toContain("allow-scripts");
    expect(flags).not.toContain("allow-same-origin");
    expect(EMBED_IFRAME_SANDBOX).toBe("allow-scripts allow-presentation allow-popups");
  });

  it("classifies media URLs by file extension / provider", () => {
    expect(classifyMedia("https://cdn.example/clip.mp4")).toBe("video");
    expect(classifyMedia("https://cdn.example/song.mp3")).toBe("audio");
    expect(classifyMedia("https://www.youtube.com/watch?v=abc123")).toBe("iframe");
    expect(classifyMedia("https://cdn.example/picture.png")).toBeNull();
  });
});

describe("MarkdownRenderer media rendering", () => {
  it("renders an mp4 image-link as a <video> with controls", () => {
    const { container } = render(<MarkdownRenderer>{"![clip](https://cdn.example/clip.mp4)"}</MarkdownRenderer>);
    const video = container.querySelector("video.md-video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("src")).toBe("https://cdn.example/clip.mp4");
    expect(video!.hasAttribute("controls")).toBe(true);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an mp3 image-link as an <audio> player", () => {
    const { container } = render(<MarkdownRenderer>{"![song](https://cdn.example/song.mp3)"}</MarkdownRenderer>);
    expect(container.querySelector("audio.md-audio")).not.toBeNull();
  });

  it("draws a bare YouTube link as a thumbnail link, and a SANDBOXED iframe (normalised) only once pressed", () => {
    const { container } = render(
      <MarkdownRenderer>{"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}</MarkdownRenderer>,
    );
    // Before the press: no iframe, no request to the player; the thumbnail is a link to the video.
    expect(container.querySelector("iframe")).toBeNull();
    const link = container.querySelector("a.md-lite-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(container.querySelector("img.md-lite-thumb")!.getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    fireEvent.click(link);
    const iframe = container.querySelector(".md-embed-iframe iframe") as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(iframe!.getAttribute("sandbox")).toBe(EMBED_IFRAME_SANDBOX);
    expect(iframe!.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("a modified click on the thumbnail keeps the link's own meaning (open in a new tab)", () => {
    const { container } = render(<MarkdownRenderer>{"https://vimeo.com/76979871"}</MarkdownRenderer>);
    fireEvent.click(container.querySelector("a.md-lite-link")!, { ctrlKey: true });
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("the audio speed button cycles 1× → 1.25× → 1.5× → 2× → 1× and sets the player's speed", () => {
    const { container } = render(<MarkdownRenderer>{"![song](https://cdn.example/song.mp3)"}</MarkdownRenderer>);
    const button = container.querySelector("button.md-audio-speed") as HTMLButtonElement;
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(button.hidden).toBe(false); // the app is the script
    const seen: string[] = [button.textContent!];
    for (let i = 0; i < 4; i++) { fireEvent.click(button); seen.push(button.textContent!); }
    expect(seen).toEqual(["1×", "1.25×", "1.5×", "2×", "1×"]);
    fireEvent.click(button);
    expect(audio.playbackRate).toBe(1.25);
  });

  it("an uploaded video loads only its metadata and first frame (a still, not a black box) and has no poster of its own", () => {
    const { container } = render(<MarkdownRenderer>{"![clip](https://cdn.example/clip.mp4)"}</MarkdownRenderer>);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("poster")).toBe(false);
  });

  it("SECURITY: raw-HTML <iframe> pointing at an untrusted host is DROPPED", () => {
    const md = '<iframe src="https://evil.example/pwn"></iframe>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    // No iframe at all — not the evil one, not a rewritten one.
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("SECURITY: a <script> in raw HTML never reaches the DOM", () => {
    const md = '<p>hi</p><script>window.__pwned=1</script>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("renders a raw-HTML <iframe> to a trusted host, re-sandboxed", () => {
    const md = '<iframe src="https://player.vimeo.com/video/76979871"></iframe>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    fireEvent.click(container.querySelector("a.md-lite-link")!);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe(EMBED_IFRAME_SANDBOX);
  });

  // Published Onden sites (and so their RSS feeds) inline media as data URIs —
  // the reader must PLAY them, while data: stays dead everywhere else.
  it("keeps inline data:audio through sanitize + urlTransform (the reader's feed audio)", () => {
    const md = '<audio controls><source src="data:audio/mpeg;base64,AAAA" type="audio/mpeg"></audio>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const source = container.querySelector("audio source");
    expect(source).not.toBeNull();
    expect(source!.getAttribute("src")).toBe("data:audio/mpeg;base64,AAAA");
  });

  it("keeps inline data:image on <img>", () => {
    const md = '<img src="data:image/png;base64,BBBB" alt="pic">';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const img = container.querySelector("img.md-image");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,BBBB");
  });

  it("SECURITY: a data:text/html iframe is DROPPED (host gate has no host to trust)", () => {
    const md = '<iframe src="data:text/html,<script>pwn()</script>"></iframe>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("SECURITY: a data: HREF stays stripped (urlTransform only frees src)", () => {
    const md = '<a href="data:text/html,<script>pwn()</script>">click</a>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href") ?? "").toBe("");
  });
});
