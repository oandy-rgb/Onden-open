// Feed / item URL rules — pure, DB-free (depth audit D53).

import { describe, it, expect } from "vitest";
import { feedUrl, feedUrlKey, itemUrl } from "./feedUrl.js";

describe("feedUrl", () => {
  it("turns feed:// and feed:https:// into a fetchable https URL", () => {
    expect(feedUrl("feed://example.com/rss.xml")).toBe("https://example.com/rss.xml");
    expect(feedUrl("FEED://example.com/rss.xml")).toBe("https://example.com/rss.xml");
    expect(feedUrl("feed:https://example.com/rss.xml")).toBe("https://example.com/rss.xml");
    expect(feedUrl("feed:http://example.com/rss.xml")).toBe("http://example.com/rss.xml");
  });

  it("refuses every other protocol and non-URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:text/xml,<rss/>", "file:///etc/passwd", "ftp://x/f", "not-a-url", "", "feed:"]) {
      expect(feedUrl(bad)).toBeNull();
    }
  });

  it("stores one form: lower-case scheme and host, no default port, no fragment; the path is kept", () => {
    expect(feedUrl("  HTTPS://Example.COM:443/Feed/#top ")).toBe("https://example.com/Feed/");
    expect(feedUrl("http://example.com:80/feed?x=1")).toBe("http://example.com/feed?x=1");
  });

  it("matches /feed/ and /feed (and host case) as one subscription", () => {
    expect(feedUrlKey("https://x.example/feed/")).toBe(feedUrlKey("https://X.example/feed"));
    expect(feedUrlKey("feed://x.example/feed/")).toBe(feedUrlKey("https://x.example/feed"));
    expect(feedUrlKey("https://x.example/")).toBe("https://x.example/");
    expect(feedUrlKey("https://x.example/a")).not.toBe(feedUrlKey("https://x.example/b"));
  });
});

describe("itemUrl", () => {
  it("resolves a relative item link against the feed", () => {
    expect(itemUrl("/posts/1", "https://blog.example/atom.xml")).toBe("https://blog.example/posts/1");
    expect(itemUrl("posts/2", "https://blog.example/feeds/atom.xml")).toBe("https://blog.example/feeds/posts/2");
    expect(itemUrl("https://other.example/a", "https://blog.example/atom.xml")).toBe("https://other.example/a");
  });

  it("drops empty and non-http(s) links", () => {
    expect(itemUrl(null, "https://blog.example/atom.xml")).toBeNull();
    expect(itemUrl("  ", "https://blog.example/atom.xml")).toBeNull();
    expect(itemUrl("javascript:alert(1)", "https://blog.example/atom.xml")).toBeNull();
  });
});
