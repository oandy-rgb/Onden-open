// Media and embeds in the exports (md2html, the published profile of
// @onden/markdown): drawn from Markdown the way the site draws them — a media
// image as a player, a trusted YouTube/Vimeo URL as a sandboxed embed — while
// a note's inline HTML stays visible text, as on the site — except the tags
// Onden's own editor writes (<u>, <mark>, <audio>, <video>, <source>; the
// user's call 2026-10-14), parsed and sanitized. The published page is served on the
// owner's domain, so an unrestricted iframe would be an XSS/clickjacking
// surface: only trusted hosts are ever framed, always sandboxed.

import { describe, it, expect } from "vitest";
import { md2html } from "../modules/website/publishing/index.js";
import { EMBED_IFRAME_SANDBOX } from "@onden/markdown";

describe("md2html media and embeds", () => {
  it("a bare trusted YouTube link becomes a click-to-load embed: a thumbnail that is a link to the video, no iframe yet", () => {
    const html = md2html("https://www.youtube.com/watch?v=abc123");
    expect(html).toContain('<span class="md-embed md-embed-lite">'); // allowed inside the paragraph
    expect(html).toContain('<a class="md-lite-link" href="https://www.youtube.com/watch?v=abc123"');
    expect(html).toContain('src="https://i.ytimg.com/vi/abc123/hqdefault.jpg"');
    // the player waits, inert, in a <template>: nothing is framed until a reader presses play
    expect(html).toMatch(/<template><iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/abc123"[^>]*sandbox=/);
    expect(EMBED_IFRAME_SANDBOX).toContain("allow-scripts"); // the iframe the page script makes is sandboxed with this
  });

  it("an uploaded video loads only its metadata and first frame; audio has its hidden speed button", () => {
    expect(md2html("![c](https://example.com/c.mp4)")).toContain('preload="metadata"');
    const audio = md2html("![s](https://example.com/s.mp3)");
    expect(audio).toMatch(/<button[^>]*class="md-audio-speed"[^>]*data-audio-speed[^>]*hidden/);
  });

  it("a trusted Vimeo image link becomes an embed", () => {
    expect(md2html("![talk](https://vimeo.com/76979871)")).toContain('<template><iframe src="https://player.vimeo.com/video/76979871"');
  });

  it("an untrusted host, or a labelled link, stays a link", () => {
    const evil = md2html("https://youtube.com.evil.example/watch?v=x");
    expect(evil).not.toContain("<iframe");
    expect(md2html("[watch this](https://www.youtube.com/watch?v=abc123)")).not.toContain("<iframe");
  });

  it("media images become players", () => {
    expect(md2html("![clip](https://cdn.example/clip.mp4)")).toContain('<video src="https://cdn.example/clip.mp4" controls');
    expect(md2html("![song](https://cdn.example/song.mp3)")).toContain('<audio src="https://cdn.example/song.mp3" controls');
  });

  it("keeps INLINE data: images (published bundles + feeds embed media as data URIs)", () => {
    expect(md2html("![dot](data:image/png;base64,iVBORw0KGgo=)")).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("SECURITY: other inline HTML is text — no iframe or script element reaches the page", () => {
    for (const raw of [
      '<iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>',
      '<iframe src="https://evil.example/pwn"></iframe>',
      '<iframe src="data:text/html,<script>pwn()</script>"></iframe>',
      "<script>alert(1)</script>",
    ]) {
      const html = md2html(raw);
      expect(html).not.toMatch(/<(iframe|script)\b/);
      expect(html).toContain("&#x3C;");
    }
  });

  it("the editor's own tags render, sanitized: <video>/<audio> players, <u>, <mark>", () => {
    const video = md2html('<video controls src="https://cdn.example/clip.mp4" onerror="pwn()" style="max-width:100%"></video>');
    expect(video).toContain('<video controls src="https://cdn.example/clip.mp4"></video>');
    expect(md2html('<audio controls src="https://cdn.example/a.mp3"></audio>')).toContain("<audio controls");
    expect(md2html("a <u>b</u> <mark>c</mark>")).toContain("a <u>b</u> <mark>c</mark>");
  });

  it("the embed sandbox never grants allow-same-origin (no cross-frame escape)", () => {
    expect(EMBED_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("mermaid ships as <pre class=\"mermaid\"> (drawn by the site, source offline)", () => {
    const html = md2html("```mermaid\ngraph TD; A-->B;\n```");
    expect(html).toContain('<pre class="mermaid">graph TD; A-->B;</pre>');
  });
});

describe("md2html embed titles", () => {
  const embed = "![](https://vimeo.com/76979871)";
  it("an unlabelled embed's title is in the site's language, English for any other", () => {
    expect(md2html(embed, { pages: [], locale: "zh-TW" })).toContain('aria-label="嵌入媒體"');
    expect(md2html(embed, { pages: [], locale: "ja" })).toContain('aria-label="埋め込みメディア"');
    expect(md2html(embed, { pages: [], locale: "en" })).toContain('aria-label="Embedded media"');
    expect(md2html(embed)).toContain('aria-label="Embedded media"');
  });
});
