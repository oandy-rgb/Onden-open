import { describe, it, expect } from "vitest";
import { escapeHtml, decodeHtmlEntities } from "./html.js";

describe("escapeHtml", () => {
  it("escapes & < > \" and leaves ' (attributes are always double-quoted)", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry's&lt;/a&gt;");
  });

  it("leaves other text alone", () => {
    expect(escapeHtml("中文 hello")).toBe("中文 hello");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes &amp;lt; to the literal text &lt; (not to <)", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeHtmlEntities("&amp;#39;")).toBe("&#39;");
  });

  it("decodes the named entities", () => {
    expect(decodeHtmlEntities("&lt;b&gt; &quot;q&quot; &#39;s&apos; a&amp;b x&nbsp;y")).toBe(`<b> "q" 's' a&b x y`);
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("&#65;&#x42;&#X43;&#20013;&#x1F600;")).toBe("ABC中😀");
  });

  it("keeps unknown and invalid entities as written", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800; &#x110000; & alone &constructor;")).toBe("&bogus; &#0; &#xD800; &#x110000; & alone &constructor;");
  });

  it("round-trips escapeHtml", () => {
    for (const s of [`<script>alert("x")</script>`, "a &amp; b", "&lt;", "it's & \"quoted\"", "中文 &#20013;"]) {
      expect(decodeHtmlEntities(escapeHtml(s))).toBe(s);
    }
  });
});
