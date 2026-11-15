// Feed HTML sanitation — pure, DB-free.

import { describe, it, expect } from "vitest";
import { absolutizeUrls, sanitizeFeedHtml, extractArticleHtml, htmlToText } from "./sanitize.js";

describe("sanitizeFeedHtml", () => {
  it("strips script/style/iframe blocks, on* handlers and javascript: urls", () => {
    const dirty = `<p onclick="evil()">Hello</p>
<script>alert(1)</script>
<style>p{display:none}</style>
<iframe src="https://evil.example"></iframe>
<a href="javascript:alert(2)">x</a>
<img src="https://ok.example/i.png" onerror="evil()">`;
    const clean = sanitizeFeedHtml(dirty);
    expect(clean).toContain("Hello");
    expect(clean).toContain("https://ok.example/i.png");
    expect(clean).not.toMatch(/<script|<style|<iframe|onclick|onerror|javascript:/i);
  });

  it("keeps ordinary article markup intact", () => {
    const ok = `<h2>Title</h2><p>Body with <strong>bold</strong> and <a href="https://x.example">a link</a>.</p>`;
    expect(sanitizeFeedHtml(ok)).toBe(ok);
  });
});

describe("extractArticleHtml", () => {
  it("prefers <article>, drops page chrome, sanitizes the result", () => {
    const page = `<html><head><title>t</title><script>nav()</script></head><body>
      <nav>menu menu</nav>
      <article><h1>The Story</h1><p>Real content.</p><script>track()</script></article>
      <footer>©</footer>
    </body></html>`;
    const out = extractArticleHtml(page);
    expect(out).toContain("The Story");
    expect(out).toContain("Real content.");
    expect(out).not.toContain("menu menu");
    expect(out).not.toMatch(/<script|©/);
  });

  it("falls back to <body> when no article/main exists", () => {
    const page = `<html><body><p>plain page</p><aside>related</aside></body></html>`;
    const out = extractArticleHtml(page);
    expect(out).toContain("plain page");
    expect(out).not.toContain("related");
  });

  it("keeps <figure> images — article figures are content, not chrome", () => {
    const page = `<html><body><article>
      <p>text</p>
      <figure><img src="https://pics.test/a.png"><figcaption>cap</figcaption></figure>
    </article></body></html>`;
    const out = extractArticleHtml(page);
    expect(out).toContain('src="https://pics.test/a.png"');
    expect(out).toContain("cap");
  });

  it("absolutizes relative src/href/srcset against the page url", () => {
    const page = `<html><body><article>
      <img src="/img/pic.png" srcset="/img/pic.png 1x, img/pic@2x.png 2x">
      <a href="../other/post">link</a>
      <img src="https://cdn.test/abs.png">
      <img src="data:image/png;base64,AA">
    </article></body></html>`;
    const out = extractArticleHtml(page, "https://blog.test/posts/entry/");
    expect(out).toContain('src="https://blog.test/img/pic.png"');
    expect(out).toContain('srcset="https://blog.test/img/pic.png 1x, https://blog.test/posts/entry/img/pic@2x.png 2x"');
    expect(out).toContain('href="https://blog.test/posts/other/post"');
    expect(out).toContain('src="https://cdn.test/abs.png"');   // absolute untouched
    expect(out).toContain('src="data:image/png;base64,AA"');   // data: untouched
  });

  it("absolutizes unquoted values too (minified pages write src=/a.png)", () => {
    const page = `<html><body><article><p><img decoding=async alt=pic src=/assets/images/wrong.png width=598 class=img_ev3q />
      <a href=../other>link</a> <img data-src=/lazy.png src=data:image/gif;base64,R0>
      <img srcset=/s.png alt=x></article></body></html>`;
    const out = extractArticleHtml(page, "https://wiwi.blog/blog/wrong-word-order");
    expect(out).toContain('src="https://wiwi.blog/assets/images/wrong.png"');
    expect(out).toContain('href="https://wiwi.blog/other"');
    expect(out).toContain('src="https://wiwi.blog/lazy.png"');
    expect(out).toContain('srcset="https://wiwi.blog/s.png"');
    expect(out).not.toMatch(/src="?\/assets/);
  });

  it("promotes lazy-load data-src when src is missing or a placeholder", () => {
    const page = `<html><body><article>
      <img data-src="https://pics.test/lazy.png">
      <img src="data:image/gif;base64,R0" data-src="https://pics.test/lazy2.png">
      <img src="https://pics.test/real.png" data-src="https://pics.test/decoy.png">
    </article></body></html>`;
    const out = extractArticleHtml(page);
    expect(out).toContain('src="https://pics.test/lazy.png"');
    expect(out).toContain('src="https://pics.test/lazy2.png"');
    expect(out).toContain('src="https://pics.test/real.png"'); // a real src wins
    expect(out).not.toContain(' src="https://pics.test/decoy.png"'); // never promoted over it
  });
});

describe("htmlToText", () => {
  it("flattens tags + entities and caps length", () => {
    expect(htmlToText("<p>a &amp; b</p>")).toBe("a & b");
    // Escaped entity text stays text: `&amp;lt;` is the literal "&lt;", not "<".
    expect(htmlToText("<p>&amp;lt;tag&amp;gt; &#20013;</p>")).toBe("&lt;tag&gt; 中");
    expect(htmlToText(`<p>${"x".repeat(500)}</p>`, 10)).toHaveLength(10);
  });
});

describe("absolutizeUrls", () => {
  it("resolves a podcast's relative audio src against the article, not Onden", () => {
    const html = '<p><audio class="x" src="/assets/medias/podcast.mp3" controls></audio></p><img src=pic.png><a href="#n">n</a>';
    const out = absolutizeUrls(html, "https://jaron.tw/blog/wish");
    expect(out).toContain('src="https://jaron.tw/assets/medias/podcast.mp3"');
    expect(out).toContain('src="https://jaron.tw/blog/pic.png"');
    expect(out).toContain('href="#n"');
  });
  it("leaves absolute and data: urls alone, and everything without an article url", () => {
    const html = '<audio src="https://cdn.example/a.mp3"></audio><img src="data:image/png;base64,AA">';
    expect(absolutizeUrls(html, "https://jaron.tw/blog/wish")).toBe(html);
    expect(absolutizeUrls('<audio src="/a.mp3">', null)).toBe('<audio src="/a.mp3">');
  });
});

describe("video embeds", () => {
  it("a YouTube or Vimeo player stays as a link to the player; any other iframe goes", () => {
    const out = sanitizeFeedHtml(
      '<p>看：</p><iframe width="560" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=x" allowfullscreen></iframe>'
      + '<iframe src="https://player.vimeo.com/video/76979871"></iframe>'
      + '<iframe src="https://evil.example/x"></iframe>',
    );
    expect(out).toContain('<a href="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ">');
    expect(out).toContain('<a href="https://player.vimeo.com/video/76979871">');
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/<iframe/i);
  });
});
