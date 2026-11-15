import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { feedResponse } from "./_feedResponse";
import type { SiteSnapshot } from "../../lib/siteFeed";
import type { PublishedNode } from "../../lib/publishedNode";

const PUBLIC = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3";
const PRIVATE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp3";
const node = (id: string, markdown: string): PublishedNode =>
  ({ id, node_type: "content", title: id, slug: id, markdown, updated_at: "2026-01-01T00:00:00Z" }) as PublishedNode;
const nodes = [
  node("ep1", `# ep1\n\n![talk](/api/media/${PUBLIC})`),
  node("secret", `# secret\n\n![x](/api/media/${PRIVATE})`),
  node("text", "# text\n\nwords"),
];
const snapshot = (published: PublishedNode[]): SiteSnapshot =>
  ({ nodes: published, site: { brand: "Garden" }, tagSlugs: [], tagPages: {}, redirects: [] });

// The server's anonymous HEAD: the private note's file is a 404.
const stubHead = () => vi.stubGlobal("fetch", vi.fn(async (url: string) =>
  String(url).includes(PUBLIC) ? new Response(null, { status: 200, headers: { "content-length": "1234" } }) : new Response(null, { status: 404 })));

describe("feedResponse (the one feed writer: whole site and tag feeds)", () => {
  beforeAll(async () => { await loadAllEnhancers(); });
  afterEach(() => vi.unstubAllGlobals());

  it("a public audio file becomes an enclosure, with the podcast channel tags", async () => {
    stubHead();
    const xml = await (await feedResponse({ snapshot: snapshot(nodes), origin: "https://x.example", nodes })).text();
    expect(xml).toContain(`<enclosure url="https://x.example/api/media/${PUBLIC}" length="1234" type="audio/mpeg"/>`);
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(xml).toContain("<itunes:explicit>false</itunes:explicit>");
  });

  it("a private note's audio never gets an enclosure", async () => {
    stubHead();
    const xml = await (await feedResponse({ snapshot: snapshot(nodes), origin: "https://x.example", nodes })).text();
    expect(xml).not.toContain(`enclosure url="https://x.example/api/media/${PRIVATE}`);
    expect(xml.match(/<enclosure /g)).toHaveLength(1);
  });

  it("a tag feed gets the same enclosures", async () => {
    stubHead();
    const xml = await (await feedResponse({
      snapshot: snapshot(nodes), origin: "https://x.example", nodes: [nodes[0]!], tag: { name: "Talks", path: "/site/tag/talks/" },
    })).text();
    expect(xml).toContain("<title>Talks — Garden</title>");
    expect(xml).toContain("<enclosure ");
  });

  it("a site without audio gets exactly the plain feed (no podcast tags)", async () => {
    stubHead();
    const xml = await (await feedResponse({ snapshot: snapshot([nodes[2]!]), origin: "https://x.example", nodes: [nodes[2]!] })).text();
    expect(xml).not.toContain("itunes");
    expect(xml).not.toContain("<enclosure");
  });
});
