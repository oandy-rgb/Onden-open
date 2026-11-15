// Random test of the RSS feed parser (modules/rss/fetch.ts fetchAndParseFeed) and of the
// reading list's cursor (modules/rss/itemList.ts listStagedItems).
//
// The parser is reached the way production reaches it: a feed is rendered to XML, encoded to
// BYTES (UTF-8, Big5, GBK or Shift_JIS), served by a local HTTP server with or without a
// Content-Type charset, and fetched through the real services/safeFetch.ts. So how bytes
// become text is part of what is tested (`SAFE_FETCH_ALLOW_PRIVATE` is the test-only loopback
// switch safeFetch documents). Feeds are RSS 2.0 and Atom with: items with and without
// guid / Atom id, description / content:encoded / summary / content bodies (escaped or in
// CDATA, with entities), duplicate links, odd or missing dates, enclosures, a BOM or blank
// lines before the prolog.
//
// Invariants (generated feeds are well-formed XML; truncated or non-XML input is not covered):
//   1. parsing never throws, whatever the encoding, declaration, dates or markup
//   2. an item that has text (a description, content or summary) comes back with a non-empty body
//   3. an item keeps its identity (`guid`) when only its link changes
//   4. two items with different ids are both kept, even with the same link, title or date
//   5. titles and bodies come back exactly as written, for every declared encoding
//   6. the reading list's cursor loses no item at a page boundary, dated or not
//
// Known defects on main are KNOWN cases: the property runs over the part of the domain where
// the defect lives and is `it.fails` (it goes red the day the defect is fixed, which is the cue
// to drop `.fails`), and a minimal named case sits next to it. Every other property runs over
// the rest of the domain and must stay green. Nothing is weakened: the invariants above are
// asserted as written, the domains only split which test owns a failure.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/rssFeedParse.property.test.ts
// The cursor property needs a `*_test` database (it skips otherwise); the rest is database-free.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { fetchAndParseFeed, __setFeedFetchForTests, type FeedItem } from "../../modules/rss/fetch.js";
import { listStagedItems } from "../../modules/rss/itemList.js";
import { subscribe } from "../../modules/rss/subscriptions.js";
import type { ActorCtx } from "../../types.js";
import { CHARSET_LABELS, LEGACY_CHARSETS, charsetRepertoire, encodeLegacy, type LegacyCharset } from "../helpers/legacyCharsets.js";
import { persistActor } from "../helpers/persistActor.js";
import { PROPS_RUNS, PROPS_SEED, checkAsync } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";
import { isTestDatabase } from "../helpers/testDatabase.js";

// ── Serving bytes ───────────────────────────────────────────────────────────

const served = new Map<string, { contentType: string | null; bytes: Buffer }>();
let server: Server;
let origin = "";

beforeAll(async () => {
  vi.stubEnv("SAFE_FETCH_ALLOW_PRIVATE", "1");
  server = createServer((req, res) => {
    const hit = served.get(req.url ?? "");
    res.statusCode = hit ? 200 : 404;
    if (hit?.contentType) res.setHeader("content-type", hit.contentType);
    res.end(hit?.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Serve `bytes` once and fetch them through fetchAndParseFeed (the production path). */
async function fetchServed(bytes: Buffer, contentType: string | null): Promise<FeedItem[]> {
  const path = `/${randomUUID()}.xml`;
  served.set(path, { contentType, bytes });
  try { return (await fetchAndParseFeed(origin + path)).items; } finally { served.delete(path); }
}

// ── The feed model ──────────────────────────────────────────────────────────

const BOM = "\uFEFF";
type Kind = "rss" | "atom";
type Charset = "utf-8" | LegacyCharset;
/** RSS: description / content:encoded. Atom: summary / content. `none`: no body element at all. */
type BodyKind = "none" | "first" | "second" | "both";
type Declare = "prolog" | "header" | "both";

type ItemSpec = {
  /** guid (RSS) or Atom id; null = the feed gives the item no id. */
  id: string | null;
  title: string;
  link: string | null;
  /** Raw text of the date element; null = no date element. */
  date: string | null;
  /** The body as HTML source (what the reader will sanitize), before XML escaping. */
  html: string;
  body: BodyKind;
  cdata: boolean;
  enclosure: boolean;
};
type FeedSpec = {
  kind: Kind;
  charset: Charset;
  declare: Declare;
  label: string;
  /** What comes before the XML prolog: nothing, a BOM or blank lines. */
  lead: "" | "﻿" | "\n\n";
  items: ItemSpec[];
};

const hasText = (item: ItemSpec) => item.body !== "none";

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function attrEscape(text: string): string { return xmlEscape(text).replace(/"/g, "&quot;"); }
/** CDATA cannot hold `]]>`; the standard way is to end the section early. */
function cdata(text: string): string { return `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`; }
const htmlEscape = xmlEscape;

function renderItem(kind: Kind, item: ItemSpec, index: number): string {
  const text = (value: string) => (item.cdata ? cdata(value) : xmlEscape(value));
  const parts: string[] = [];
  if (kind === "rss") {
    parts.push(`<title>${text(item.title)}</title>`);
    if (item.link !== null) parts.push(`<link>${xmlEscape(item.link)}</link>`);
    if (item.id !== null) parts.push(`<guid isPermaLink="false">${xmlEscape(item.id)}</guid>`);
    if (item.date !== null) parts.push(`<pubDate>${xmlEscape(item.date)}</pubDate>`);
    if (item.body === "first" || item.body === "both") parts.push(`<description>${text(item.html)}</description>`);
    if (item.body === "second" || item.body === "both") parts.push(`<content:encoded>${text(item.html)}</content:encoded>`);
    if (item.enclosure) parts.push(`<enclosure url="https://cdn.example.com/${index}.mp3" length="1234" type="audio/mpeg"/>`);
    return `<item>${parts.join("")}</item>`;
  }
  if (item.id !== null) parts.push(`<id>${xmlEscape(item.id)}</id>`);
  parts.push(`<title>${text(item.title)}</title>`);
  if (item.link !== null) parts.push(`<link rel="alternate" type="text/html" href="${attrEscape(item.link)}"/>`);
  if (item.enclosure) parts.push(`<link rel="enclosure" type="audio/mpeg" length="1234" href="https://cdn.example.com/${index}.mp3"/>`);
  if (item.date !== null) parts.push(`<updated>${xmlEscape(item.date)}</updated>`);
  if (item.body === "first" || item.body === "both") parts.push(`<summary type="html">${text(item.html)}</summary>`);
  if (item.body === "second" || item.body === "both") parts.push(`<content type="html">${text(item.html)}</content>`);
  return `<entry>${parts.join("")}</entry>`;
}

/** The XML document as text, and the Content-Type header to send with its bytes. */
function render(spec: FeedSpec): { xml: string; contentType: string | null } {
  const inProlog = spec.declare === "prolog" || spec.declare === "both";
  const inHeader = spec.declare === "header" || spec.declare === "both";
  const prolog = `<?xml version="1.0"${inProlog ? ` encoding="${spec.label}"` : ""}?>`;
  const body = spec.items.map((item, i) => renderItem(spec.kind, item, i)).join("\n");
  const xml = spec.kind === "rss"
    ? `${spec.lead}${prolog}<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>\n${body}\n</channel></rss>`
    : `${spec.lead}${prolog}<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><id>urn:feed</id>\n${body}\n</feed>`;
  const mime = spec.kind === "rss" ? "application/rss+xml" : "application/atom+xml";
  return { xml, contentType: inHeader ? `${mime}; charset=${spec.label}` : null };
}

function encode(xml: string, charset: Charset): Buffer {
  return charset === "utf-8" ? Buffer.from(xml, "utf8") : encodeLegacy(xml, charset);
}

async function parse(spec: FeedSpec): Promise<FeedItem[]> {
  const { xml, contentType } = render(spec);
  return fetchServed(encode(xml, spec.charset), contentType);
}

// ── Generators ──────────────────────────────────────────────────────────────

const ASCII_CHARS = [..."abcXYZ019&<>\"'$[]]>-_./:;=?!#%*+"];
const UNICODE_EXTRAS = ["é", "ß", "ñ", "한", "😀", "𠀀", "é", "İ"];
const SAMPLE = 400;

const repertoires = new Map<Charset, string[]>();
function repertoire(charset: Charset): string[] {
  let list = repertoires.get(charset);
  if (!list) {
    if (charset === "utf-8") list = [...UNICODE_EXTRAS, ...charsetRepertoire("big5").slice(0, 60), ...charsetRepertoire("shift_jis").slice(0, 60)];
    else {
      // Spread over the whole table (kanji, kana, hanzi, symbols), not its first rows.
      const all = charsetRepertoire(charset);
      const step = Math.max(1, Math.floor(all.length / SAMPLE));
      list = all.filter((_, i) => i % step === 0).slice(0, SAMPLE);
    }
    repertoires.set(charset, list);
  }
  return list;
}

/** One word: ASCII (with XML / HTML specials) and, when `wide`, characters of the charset. */
const word = (charset: Charset, wide: boolean): fc.Arbitrary<string> =>
  fc.array(wide ? fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...ASCII_CHARS) }, { weight: 2, arbitrary: fc.constantFrom(...repertoire(charset)) }) : fc.constantFrom(...ASCII_CHARS),
    { minLength: 1, maxLength: 5 }).map((chars) => chars.join(""));

/** Words joined by single spaces: no edge whitespace, nothing the parser may legitimately trim. */
const plainText = (charset: Charset, wide: boolean): fc.Arbitrary<string> =>
  fc.array(word(charset, wide), { minLength: 1, maxLength: 4 }).map((words) => words.join(" "));

/** Text with at least one character outside ASCII: it cannot survive if the bytes are read in the wrong charset. */
const wideText = (charset: Charset): fc.Arbitrary<string> =>
  fc.tuple(fc.constantFrom(...repertoire(charset)), plainText(charset, true)).map(([first, rest]) => `${first}${rest}`);

const htmlBody = (charset: Charset, wide: boolean): fc.Arbitrary<string> =>
  fc.array(fc.tuple(plainText(charset, wide), fc.constantFrom("", "&nbsp;", "&#169;", "<br/>")), { minLength: 1, maxLength: 3 })
    .map((paras) => paras.map(([text, extra]) => `<p>${htmlEscape(text)}${extra}</p>`).join(""));

/** Dates every parser path accepts: empty, a real date in either feed's format, a date JS rolls over or reads with an odd offset. */
const TOLERATED_DATES = ["", "2026-02-30T10:00:00Z", "Tue, 10 Nov 2026 09:00:00 +2500", "2026-11-10", "Tue, 10 Nov 2026 09:00:00 GMT"];
/** Text that is no date. An RSS item keeps it as it came (fetch.ts drops it later); an Atom entry makes rss-parser throw. */
const UNPARSEABLE_DATES = ["yesterday", " ", "Mon, 32 Foo 2026 25:61:61 GMT", "0000-00-00", "1e9"];
const dateText = (kind: Kind, withUnparseable: boolean): fc.Arbitrary<string | null> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: fc.date({ min: new Date("1971-01-01"), max: new Date("2035-01-01"), noInvalidDate: true }).map((d) => (kind === "rss" ? d.toUTCString() : d.toISOString())) },
    { weight: 2, arbitrary: fc.constantFrom(...TOLERATED_DATES) },
    ...(withUnparseable ? [{ weight: 2, arbitrary: fc.constantFrom(...UNPARSEABLE_DATES) }] : []),
  );

const ID_PREFIXES = ["urn:uuid:", "tag:example.org,2026:", "https://example.com/?p=", "文章-", ""];
const LINKS = ["https://example.com/post/1", "https://example.com/post/2", "/relative/post", "https://example.com/post/1?utm_source=feed"];

type Options = {
  kind?: Kind;
  charset?: fc.Arbitrary<Charset>;
  /** Titles, links and dates may repeat between items (otherwise every item can be told apart without its id). */
  collisions: boolean;
  /** Every item carries an id. */
  allIds?: boolean;
  /** Every item shares this one link (collisions only). */
  sameLink?: boolean;
  bodies?: BodyKind[];
  /** Dates that are no date: on by default for RSS only, because on an Atom feed one of them makes the parser throw. */
  unparseableDates?: boolean;
  /** At least the first item has an unparseable date. */
  forceUnparseable?: boolean;
  /** At least one title and body character outside ASCII. */
  wide?: boolean;
  minItems?: number;
};

function feedSpec(opts: Options): fc.Arbitrary<FeedSpec> {
  const kind = opts.kind ? fc.constant(opts.kind) : fc.constantFrom<Kind>("rss", "atom");
  const charset = opts.charset ?? fc.constantFrom<Charset>("utf-8", ...LEGACY_CHARSETS);
  return fc.tuple(kind, charset, fc.integer({ min: 0, max: 99 })).chain(([k, cs, token]) => {
    const label = fc.constantFrom(...CHARSET_LABELS[cs]);
    const declare = fc.constantFrom<Declare>("prolog", "header", "both");
    // A BOM is a UTF-8 thing: the legacy charsets have no code for it.
    const lead = fc.constantFrom<FeedSpec["lead"]>(...(cs === "utf-8" ? ["", "", "", BOM, "\n\n"] as const : ["", "", "\n\n"] as const));
    const item = (index: number): fc.Arbitrary<ItemSpec> => fc.record({
      hasId: opts.allIds ? fc.constant(true) : fc.boolean(),
      idPrefix: fc.constantFrom(...ID_PREFIXES),
      title: opts.collisions ? fc.constantFrom("Same title", "題目") : (opts.wide ? wideText(cs) : plainText(cs, true)),
      link: opts.sameLink ? fc.constant<string | null>(LINKS[0]!) : opts.collisions ? fc.constantFrom<string | null>(null, ...LINKS) : fc.constantFrom<string | null>(null, "unique"),
      date: dateText(k, opts.unparseableDates ?? k === "rss"),
      html: htmlBody(cs, true),
      body: fc.constantFrom<BodyKind>(...(opts.bodies ?? ["none", "first", "second", "both"])),
      cdata: fc.boolean(),
      enclosure: fc.boolean(),
    }).map((r): ItemSpec => {
      const id = r.hasId ? `${r.idPrefix}${token}-${index}` : null;
      // An item that is only told apart by its own link or title (no id, or collisions off) gets a
      // link of its own or none, and a numbered title; only an item with an id may repeat them.
      const identified = id !== null && opts.collisions;
      const link = identified || r.link === null ? r.link : `https://example.com/own/${token}-${index}`;
      const title = identified ? r.title : `${r.title} #${index}`;
      return { id, title, link, date: r.date, html: r.html, body: r.body, cdata: r.cdata, enclosure: r.enclosure };
    });
    return fc.tuple(fc.integer({ min: opts.minItems ?? 1, max: 6 }), label, declare, lead).chain(([count, lb, dc, ld]) =>
      fc.tuple(...Array.from({ length: count }, (_, i) => item(i))).map((items): FeedSpec => ({
        kind: k, charset: cs, declare: dc, label: lb, lead: ld,
        items: opts.forceUnparseable ? items.map((it, i) => (i === 0 ? { ...it, date: UNPARSEABLE_DATES[0]! } : it)) : items,
      })));
  });
}

/** `spec` with every link replaced by a different one (or removed / added): only the links change. */
function withOtherLinks(spec: FeedSpec): FeedSpec {
  return { ...spec, items: spec.items.map((item, i) => ({ ...item, link: item.link === null ? `https://example.com/moved/${i}` : i % 2 === 0 ? null : `${item.link}?moved=${i}` })) };
}

const guidOf = (items: FeedItem[]) => items.map((i) => i.guid);

// ── 1. never throws ─────────────────────────────────────────────────────────

describe("1. parsing never throws", () => {
  it("any RSS 2.0 or Atom feed, in any of the four encodings and declarations, with odd dates, CDATA and entities", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ collisions: true }), async (spec) => {
      const items = await parse(spec);
      expect(Array.isArray(items)).toBe(true);
    }));
  }, 120_000);
});

describe("1b. one entry with a date that is no date does not stop the feed", () => {
  // KNOWN: modules/rss/fetch.ts:116 hands the document to rss-parser, whose Atom reader runs
  // `new Date(<updated|published>).toISOString()` (rss-parser/lib/parser.js:145) with no guard:
  // an entry whose date is not a date throws RangeError "Invalid time value" and the WHOLE feed
  // is refused (subscribe answers 422, every later poll fails). The same text in an RSS
  // <pubDate> is kept as text and fetch.ts later reads it as no date.
  it.fails("KNOWN: an Atom feed whose entries carry an unparseable <updated>", async () => {
    await checkAsync(fc.asyncProperty(
      feedSpec({ kind: "atom", collisions: false, charset: fc.constant("utf-8"), unparseableDates: true, forceUnparseable: true }),
      async (spec) => { expect(await parse(spec)).toHaveLength(spec.items.length); }));
  }, 120_000);

  it.fails("KNOWN (minimal): <updated>yesterday</updated> on one entry of two: both entries are listed", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><id>a</id><title>A</title><updated>2026-11-10T09:00:00Z</updated><content type="html">one</content></entry>
      <entry><id>b</id><title>B</title><updated>yesterday</updated><content type="html">two</content></entry></feed>`;
    expect(await fetchServed(Buffer.from(xml), "application/atom+xml")).toHaveLength(2);
  });

  it("the same unparseable date in an RSS <pubDate> parses, and the item has no usable date", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>A</title><pubDate>yesterday</pubDate><description>x</description></item></channel></rss>`;
    const [item] = await fetchServed(Buffer.from(xml), "application/rss+xml");
    expect(item!.contentHtml).toBe("x");
    expect(Number.isNaN(Date.parse(item!.publishedAt ?? ""))).toBe(true);
  });
});

// ── 2. an item with text has a body ─────────────────────────────────────────

describe("2. an item with text comes back with a non-empty body", () => {
  it("RSS: description and / or content:encoded; Atom: content (every item kept, in order)", async () => {
    await checkAsync(fc.asyncProperty(
      fc.oneof(
        feedSpec({ kind: "rss", collisions: false, charset: fc.constant("utf-8") }),
        feedSpec({ kind: "atom", collisions: false, charset: fc.constant("utf-8"), bodies: ["none", "second", "both"] }),
      ),
      async (spec) => {
        const items = await parse(spec);
        expect(items).toHaveLength(spec.items.length);
        spec.items.forEach((item, i) => {
          if (hasText(item)) expect(items[i]!.contentHtml, `item ${i} ${JSON.stringify(item.title)}`).not.toBe("");
        });
      }));
  }, 120_000);

  // KNOWN: modules/rss/fetch.ts:131 reads content:encoded ?? content ?? contentSnippet. rss-parser
  // puts an Atom <summary> in `summary`, and `contentSnippet` only exists when <content> does, so a
  // summary-only entry (very common: blog and release feeds) is stored with an empty body.
  it.fails("KNOWN: an Atom entry with only a <summary> has a non-empty body", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ kind: "atom", collisions: false, charset: fc.constant("utf-8"), bodies: ["first"] }), async (spec) => {
      const items = await parse(spec);
      spec.items.forEach((item, i) => expect(items[i]!.contentHtml, `item ${i}`).not.toBe(""));
    }));
  }, 120_000);

  it.fails("KNOWN (minimal): <entry><id>a</id><title>A</title><summary>text</summary></entry> has body \"text\"", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>a</id><title>A</title><link href="https://example.com/a"/><summary>text</summary></entry></feed>`;
    const [item] = await fetchServed(Buffer.from(xml), "application/atom+xml");
    expect(item!.contentHtml).toBe("text");
  });
});

// ── 3 and 4. identity ───────────────────────────────────────────────────────

describe("3. an item keeps its identity when only its link changes", () => {
  it("RSS items with a guid", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ kind: "rss", collisions: true, allIds: true, charset: fc.constant("utf-8") }), async (spec) => {
      expect(guidOf(await parse(withOtherLinks(spec)))).toEqual(guidOf(await parse(spec)));
    }));
  }, 120_000);

  // KNOWN: modules/rss/fetch.ts:86 (itemGuid) never looks at the Atom <id> rss-parser returns as
  // `it.id`: the guid is the link, or a hash of title and date. A publisher who moves a post
  // (new slug, new host, http→https) re-ingests it as a new unseen article and its saved link is lost.
  it.fails("KNOWN: Atom entries with an <id>", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ kind: "atom", collisions: false, allIds: true, charset: fc.constant("utf-8"), bodies: ["second"] }), async (spec) => {
      expect(guidOf(await parse(withOtherLinks(spec)))).toEqual(guidOf(await parse(spec)));
    }));
  }, 120_000);

  it.fails("KNOWN (minimal): the same Atom <id> with a new <link href> is the same guid", async () => {
    const atom = (href: string) => Buffer.from(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>tag:example.org,2026:1</id><title>A</title><link href="${href}"/><content type="html">x</content></entry></feed>`);
    const [before] = await fetchServed(atom("https://example.com/old-slug"), "application/atom+xml");
    const [after] = await fetchServed(atom("https://example.com/new-slug"), "application/atom+xml");
    expect(after!.guid).toBe(before!.guid);
  });
});

describe("4. two items with different ids are both kept", () => {
  it("RSS items with a guid, whatever their link, title or date", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ kind: "rss", collisions: true, allIds: true, charset: fc.constant("utf-8"), minItems: 2 }), async (spec) => {
      const guids = guidOf(await parse(spec));
      expect(guids).toHaveLength(spec.items.length);
      expect(new Set(guids).size).toBe(spec.items.length);
    }));
  }, 120_000);

  // KNOWN: same root as 3 (fetch.ts:86). Entries that share a link, or have no link and the same
  // title and date, get one guid and the second is dropped by the duplicate-guid filter (fetch.ts:124).
  it.fails("KNOWN: Atom entries with different <id> and the same link", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ kind: "atom", collisions: true, sameLink: true, allIds: true, charset: fc.constant("utf-8"), minItems: 2 }), async (spec) => {
      const guids = guidOf(await parse(spec));
      expect(guids).toHaveLength(spec.items.length);
    }));
  }, 120_000);

  it.fails("KNOWN (minimal): two Atom entries, ids a and b, one shared link: both kept", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><id>a</id><title>A</title><link href="https://example.com/same"/><content type="html">one</content></entry>
      <entry><id>b</id><title>B</title><link href="https://example.com/same"/><content type="html">two</content></entry></feed>`;
    expect(await fetchServed(Buffer.from(xml), "application/atom+xml")).toHaveLength(2);
  });

  it.fails("KNOWN (minimal): two Atom entries without a link, same title, no date, ids a and b: both kept", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><id>a</id><title>Weekly notes</title><content type="html">one</content></entry>
      <entry><id>b</id><title>Weekly notes</title><content type="html">two</content></entry></feed>`;
    expect(await fetchServed(Buffer.from(xml), "application/atom+xml")).toHaveLength(2);
  });
});

// ── 5. no mojibake ──────────────────────────────────────────────────────────

/** Titles and bodies read back exactly, and nothing else about the batch changed. */
async function expectRoundTrip(spec: FeedSpec): Promise<void> {
  const items = await parse(spec);
  expect(items).toHaveLength(spec.items.length);
  spec.items.forEach((item, i) => {
    expect(items[i]!.title, `title of item ${i} (${spec.charset} as ${spec.label}, declared ${spec.declare})`).toBe(item.title);
    if (hasText(item)) expect(items[i]!.contentHtml, `body of item ${i} (${spec.charset} as ${spec.label}, declared ${spec.declare})`).toBe(item.html);
  });
}

describe("5. titles and bodies round-trip without mojibake", () => {
  it("UTF-8 (with BOM, blank lines, entities, CDATA, wide characters), either feed kind", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ collisions: false, charset: fc.constant("utf-8"), wide: true, bodies: ["none", "second", "both"] }), expectRoundTrip));
  }, 120_000);

  it("Big5, GBK and Shift_JIS, when the text is ASCII (the bytes are the same in every charset)", async () => {
    await checkAsync(fc.asyncProperty(feedSpec({ collisions: false, charset: fc.constantFrom(...LEGACY_CHARSETS), bodies: ["none", "second", "both"] }).map((spec) => ({
      ...spec,
      items: spec.items.map((item) => ({ ...item, title: item.title.replace(/[^\x20-\x7e]/g, "x"), html: item.html.replace(/[^\x20-\x7e]/g, "x") })),
    })), expectRoundTrip));
  }, 120_000);

  // KNOWN: services/safeFetch.ts:218 always runs `Buffer.concat(chunks).toString("utf8")` and
  // fetch.ts:116 parses that string; neither the Content-Type charset nor the prolog's encoding is
  // read. A Big5, GBK or Shift_JIS feed (still common among Taiwanese, Chinese and Japanese
  // sites) reaches the reader as U+FFFD, titles and bodies both.
  for (const charset of LEGACY_CHARSETS) {
    it.fails(`KNOWN: ${charset} bytes, declared in the prolog and / or the Content-Type header`, async () => {
      await checkAsync(fc.asyncProperty(feedSpec({ collisions: false, charset: fc.constant(charset), wide: true, bodies: ["none", "second", "both"] }), expectRoundTrip));
    }, 120_000);
  }

  const minimal: Array<[LegacyCharset, string, string]> = [
    ["big5", "中文標題", "application/rss+xml; charset=big5"],
    ["gbk", "简体标题", "application/rss+xml; charset=gbk"],
    ["shift_jis", "日本語のタイトル", "application/rss+xml; charset=Shift_JIS"],
  ];
  for (const [charset, title, contentType] of minimal) {
    it.fails(`KNOWN (minimal): ${charset} title ${title} declared by Content-Type only`, async () => {
      const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>${title}</title><description>${title}</description></item></channel></rss>`;
      const [item] = await fetchServed(encodeLegacy(xml, charset), contentType);
      expect(item!.title).toBe(title);
      expect(item!.contentHtml).toBe(title);
    });
    it.fails(`KNOWN (minimal): ${charset} title ${title} declared by the prolog only`, async () => {
      const xml = `<?xml version="1.0" encoding="${CHARSET_LABELS[charset][0]}"?><rss version="2.0"><channel><title>F</title><item><title>${title}</title><description>${title}</description></item></channel></rss>`;
      const [item] = await fetchServed(encodeLegacy(xml, charset), null);
      expect(item!.title).toBe(title);
    });
  }
});

// ── 6. the list cursor ──────────────────────────────────────────────────────

const enabled = isTestDatabase();

describe.skipIf(!enabled)("6. items without a date are not lost at a page boundary", () => {
  let ws = "";
  let actor: ActorCtx;
  let sourceId = "";

  beforeAll(async () => {
    __setFeedFetchForTests(async () => ({ title: "Cursor feed", etag: null, lastModified: null, notModified: false, items: [] }));
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('RSS cursor properties', $1) RETURNING id::text`, [`rss-cursor-${randomUUID()}`])).rows[0]!.id;
    actor = await persistActor(ws, { id: "rc-a", name: "A", role: "admin", type: "human" });
    const made = await subscribe(actor, ws, { url: `https://feed.test/cursor-${randomUUID()}.xml` });
    expect(made.status).toBe(201);
    sourceId = (made.body as { id: string }).id;
    // The first fetch is kicked unawaited; let it finish (it finds nothing) before rows are written.
    for (let i = 0; i < 200; i++) {
      const left = (await q<{ n: string }>(`SELECT count(*)::text n FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`rss_fetch:${sourceId}`])).rows[0]!.n;
      if (left === "0") break;
      await new Promise((r) => setTimeout(r, 15));
    }
  });
  afterAll(() => { __setFeedFetchForTests(null); });

  type Row = { dated: boolean; ms: number; micro: number; id?: string };
  const T0 = Date.parse("2026-03-01T10:00:00.000Z");
  const isoMs = (ms: number) => new Date(T0 + ms).toISOString();
  /** `fetched_at` with microseconds, the way Postgres' now() has them. */
  const isoMicro = (ms: number, micro: number) => isoMs(ms).replace("Z", `${String(micro).padStart(3, "0")}Z`);

  /** Write the rows, then page through the list; returns the ids in the order the pages gave them. */
  async function paged(rows: Row[], limit: number): Promise<{ written: Array<{ id: string; at: string }>; seen: string[] }> {
    await seedQ(`DELETE FROM rss_staging WHERE subscription_id = $1`, [sourceId]);
    const written: Array<{ id: string; at: string }> = [];
    for (const [i, row] of rows.entries()) {
      const id = row.id ?? randomUUID();
      // A dated item sorts by published_at (the feed's ISO date, milliseconds); an undated one by
      // fetched_at, which keeps Postgres' microseconds. fetched_at of a dated item is far newer: it must not matter.
      const fetchedAt = row.dated ? isoMs(10_000_000 + i) : isoMicro(row.ms, row.micro);
      await seedQ(
        `INSERT INTO rss_staging (id, workspace_id, subscription_id, guid, title, published_at, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ws, sourceId, `g-${i}`, `item ${i}`, row.dated ? isoMs(row.ms) : null, fetchedAt]);
      written.push({ id, at: row.dated ? isoMs(row.ms) : fetchedAt });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= rows.length + 1; page++) {
      const list = await listStagedItems(actor, ws, { limit, cursor });
      if ("badCursor" in list) throw new Error(`the list refused its own cursor ${cursor}`);
      seen.push(...list.rows.map((r) => r.id));
      if (!list.nextCursor) return { written, seen };
      cursor = list.nextCursor;
    }
    throw new Error("the cursor never ended");
  }

  function expectAllOnce(result: Awaited<ReturnType<typeof paged>>): void {
    const ids = result.written.map((w) => w.id);
    expect(result.seen.filter((id, i) => result.seen.indexOf(id) !== i), "an item listed twice").toEqual([]);
    expect(ids.filter((id) => !result.seen.includes(id)).map((id) => result.written.find((w) => w.id === id)!.at), "items never listed (their timestamps)").toEqual([]);
  }

  it("rows on whole milliseconds, any ties and any page size; undated rows in their own millisecond", async () => {
    await checkAsync(fc.asyncProperty(
      fc.array(fc.record({ dated: fc.boolean(), slot: fc.integer({ min: 0, max: 4 }), micro: fc.integer({ min: 1, max: 999 }) }), { minLength: 1, maxLength: 9 }),
      fc.integer({ min: 1, max: 10 }),
      async (raw, limit) => {
        // A row may keep microseconds only when no other row shares its millisecond.
        const rows: Row[] = raw.map((r) => ({ dated: r.dated, ms: r.slot, micro: raw.filter((o) => o.slot === r.slot).length > 1 || r.dated ? 0 : r.micro }));
        expectAllOnce(await paged(rows, limit));
      }), 40);
  }, 300_000);

  // KNOWN: modules/rss/itemList.ts:44 writes the cursor with toISOString(), which keeps milliseconds,
  // while fetched_at (an undated item's sort key) keeps microseconds. The next page asks for rows
  // strictly below the truncated time, so an undated row in the same millisecond as the last row of
  // a page, but later in the microsecond, is never listed. A feed fetch inserts its undated items
  // within milliseconds of each other, so this lands on any page boundary inside one fetch.
  it.fails("KNOWN: undated items inserted within one millisecond, page size 1", async () => {
    await checkAsync(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 2, maxLength: 6 }),
      async (micros) => { expectAllOnce(await paged(micros.map((micro) => ({ dated: false, ms: 0, micro })), 1)); }), 20);
  }, 300_000);

  it.fails("KNOWN (minimal): undated items at .123900, .123400 and .123100 seconds, page size 1: all three are listed", async () => {
    expectAllOnce(await paged([900, 400, 100].map((micro) => ({ dated: false, ms: 123, micro })), 1));
  }, 120_000);

  it.fails("KNOWN (minimal): a dated item and an undated item in one millisecond, page size 1", async () => {
    // The undated row (.123500) is listed first; its cursor is .123, the dated row's own time, and the
    // dated row stays in only when its id sorts below the undated one's. Here it does not.
    const result = await paged([
      { dated: true, ms: 123, micro: 0, id: "ffffffff-0000-4000-8000-000000000000" },
      { dated: false, ms: 123, micro: 500, id: "00000000-0000-4000-8000-000000000000" },
    ], 1);
    expectAllOnce(result);
  }, 120_000);

  it("reports how it was run", () => {
    process.stderr.write(`[rssFeedParse.property] PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${PROPS_RUNS} (caps per property apply)\n`);
  });
});

