// OPML parse/serialize — pure, DB-free (module unit tests live with the
// module, like review/fsrs.test.ts).

import { describe, it, expect } from "vitest";
import { parseOpml, buildOpml } from "./opml.js";

const FEEDLY_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>subscriptions</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Example &amp; Friends" title="Example &amp; Friends"
               xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com"/>
      <outline type="rss" text="Other" xmlUrl='https://other.example/rss'/>
    </outline>
    <outline type="rss" text="Flat" title="Flat" xmlUrl="https://flat.example/atom.xml"/>
  </body>
</opml>`;

describe("opml", () => {
  it("parses nested folders flat, decoding entities, keeping only xmlUrl outlines", () => {
    const entries = parseOpml(FEEDLY_STYLE);
    expect(entries).toEqual([
      { url: "https://example.com/feed.xml", title: "Example & Friends" },
      { url: "https://other.example/rss", title: "Other" },
      { url: "https://flat.example/atom.xml", title: "Flat" },
    ]);
  });

  it("dedups repeated xmlUrls and tolerates an empty document", () => {
    const dup = `<opml><body>
      <outline xmlUrl="https://a.example/f"/><outline xmlUrl="https://a.example/f" title="again"/>
    </body></opml>`;
    expect(parseOpml(dup)).toHaveLength(1);
    expect(parseOpml("<opml><body></body></opml>")).toEqual([]);
    expect(parseOpml("not xml at all")).toEqual([]);
  });

  it("takes feed URLs through the subscribe gate: feed:// becomes https, other protocols drop, /feed/ = /feed", () => {
    const xml = `<opml><body>
      <outline title="A" xmlUrl="feed://a.example/feed/"/>
      <outline title="A again" xmlUrl="https://a.example/feed"/>
      <outline title="Bad" xmlUrl="javascript:alert(1)"/>
    </body></opml>`;
    expect(parseOpml(xml)).toEqual([{ url: "https://a.example/feed/", title: "A" }]);
  });

  it("round-trips: buildOpml output parses back to the same entries", () => {
    const entries = [
      { url: "https://example.com/feed.xml", title: `Quotes "and" <angles> & amps` },
      { url: "https://other.example/rss?a=1&b=2", title: "Other" },
    ];
    const xml = buildOpml(entries);
    expect(parseOpml(xml)).toEqual(entries);
  });
});
