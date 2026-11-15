// Feed HTML → Markdown for saved articles — pure, DB-free.

import { describe, it, expect } from "vitest";
import { htmlToMarkdown, decodeEntities } from "./htmlToMarkdown.js";

describe("htmlToMarkdown", () => {
  it("turns a typical release-notes body into readable Markdown", () => {
    const html = `<p>The Rust team is happy to announce a new version of Rust, 1.99.0.</p>
<p>If you have a previous version of Rust installed via <code>rustup</code>, you can get 1.99.0 with:</p>
<pre class="giallo z-l-code z-d-code" ><code data-lang="shellsession"><span class="giallo-l"><span>$</span><span> rustup update stable</span></span></code></pre>
<p>Check out the <a rel="external" href="https://doc.rust-lang.org/stable/releases.html">detailed release notes</a>.</p>
<h2 id="what-s-in"><a class="anchor" href="#what-s-in" aria-hidden="true"></a>
What's in 1.99.0 stable</h2>
<ul><li>one <strong>bold</strong></li><li>two <em>soft</em></li></ul>`;
    expect(htmlToMarkdown(html)).toBe([
      "The Rust team is happy to announce a new version of Rust, 1.99.0.",
      "If you have a previous version of Rust installed via `rustup`, you can get 1.99.0 with:",
      "```shellsession\n$ rustup update stable\n```",
      "Check out the [detailed release notes](https://doc.rust-lang.org/stable/releases.html).",
      "## What's in 1.99.0 stable",
      "- one **bold**\n- two *soft*",
    ].join("\n\n"));
  });

  it("keeps images, quotes, rules, ordered and nested lists", () => {
    const html = `<figure><img src="https://x.example/a.png" alt="A chart"><figcaption>Figure 1</figcaption></figure>
<blockquote><p>Quoted line</p><p>Second</p></blockquote><hr>
<ol start="3"><li>three<ul><li>inner</li></ul></li><li>four</li></ol>`;
    expect(htmlToMarkdown(html)).toBe([
      "![A chart](https://x.example/a.png)",
      "*Figure 1*",
      "> Quoted line\n>\n> Second",
      "---",
      "3. three\n   - inner\n4. four",
    ].join("\n\n"));
  });

  it("renders a simple table as a GFM table", () => {
    const html = `<table><thead><tr><th>Target</th><th>Tier</th></tr></thead><tbody><tr><td>i686</td><td>2</td></tr></tbody></table>`;
    expect(htmlToMarkdown(html)).toBe("| Target | Tier |\n| --- | --- |\n| i686 | 2 |");
  });

  it("decodes entities, keeps line breaks and drops unknown wrappers", () => {
    expect(htmlToMarkdown(`<div><span>Tom &amp; Jerry&nbsp;&#8212; line</span><br>next &lt;tag&gt;</div>`))
      .toBe("Tom & Jerry — line  \nnext <tag>");
  });

  it("escapes only what would become markup", () => {
    expect(htmlToMarkdown(`<p>snake_case stays, *stars* and [[not a link]]</p>`))
      .toBe("snake_case stays, \\*stars\\* and \\[\\[not a link]]");
    expect(htmlToMarkdown(`<p># not a heading</p>`)).toBe("\\# not a heading");
  });

  it("passes plain text through and survives unclosed tags", () => {
    expect(htmlToMarkdown("just text")).toBe("just text");
    expect(htmlToMarkdown("<p>one<p>two<ul><li>a<li>b")).toBe("one\n\ntwo\n\n- a\n- b");
  });

  it("decodeEntities handles named, decimal and hex forms", () => {
    expect(decodeEntities("&lt;&#65;&#x42;&hellip;&bogus;")).toBe("<AB…&bogus;");
  });
  it("resolves relative links and images against the article url", () => {
    const md = htmlToMarkdown('<p><img alt="pic" src="/assets/a.png"> <a href="../other">x</a> <a href="#fn">y</a></p>', "https://wiwi.blog/blog/post");
    expect(md).toContain("![pic](https://wiwi.blog/assets/a.png)");
    expect(md).toContain("[x](https://wiwi.blog/other)");
    expect(md).not.toContain("#fn");
  });

  it("keeps a podcast playable: <audio> / <video> stay, with an absolute file url", () => {
    const md = htmlToMarkdown('<p>聽聽看：</p><p><audio src="/assets/medias/podcast.mp3" controls preload="metadata"></audio></p><video><source src="clip.mp4" type="video/mp4"></video><audio></audio>', "https://jaron.tw/blog/wish");
    expect(md).toContain('<audio controls src="https://jaron.tw/assets/medias/podcast.mp3"></audio>');
    expect(md).toContain('<video controls src="https://jaron.tw/blog/clip.mp4"></video>');
    expect(md.match(/<audio/g)).toHaveLength(1);
  });
});
