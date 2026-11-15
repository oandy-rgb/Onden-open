import { describe, expect, it } from "vitest";
import { enclosureXml, firstAudioEnclosure, itunesChannelTags, type MediaHead } from "./siteFeedAudio";

const PUBLIC = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3";
const PRIVATE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp3";
// The server's answer to an anonymous HEAD: the private note's file is a 404.
const head: MediaHead = async (id) => (id === PUBLIC ? { length: 1234 } : null);
const origin = "https://example.org";

describe("firstAudioEnclosure", () => {
  it("a note with an audio file: an absolute address, the file's size and type", async () => {
    const e = await firstAudioEnclosure(`# Ep 1\n\n![talk](/api/media/${PUBLIC})`, origin, head);
    expect(e).toEqual({ url: `${origin}/api/media/${PUBLIC}`, length: 1234, type: "audio/mpeg" });
    expect(enclosureXml(e!)).toBe(`      <enclosure url="${origin}/api/media/${PUBLIC}" length="1234" type="audio/mpeg"/>`);
  });

  it("the size is 0 when the server does not say", async () => {
    const e = await firstAudioEnclosure(`![x](/api/media/${PUBLIC})`, origin, async () => ({ length: null }));
    expect(e?.length).toBe(0);
  });

  it("a note without audio has none (an image or a PDF is not an episode)", async () => {
    expect(await firstAudioEnclosure("# Text\n\n![p](/api/media/cccccccccccccccccccccccccccccccc.webp)", origin, head)).toBeNull();
    expect(await firstAudioEnclosure("just words", origin, head)).toBeNull();
  });

  it("a private note's audio never reaches the feed: the server refuses readers, so there is no enclosure", async () => {
    expect(await firstAudioEnclosure(`![secret](/api/media/${PRIVATE})`, origin, head)).toBeNull();
    // an embed of the private file does not make the next public file an enclosure of the wrong id
    const e = await firstAudioEnclosure(`![secret](/api/media/${PRIVATE}) ![ok](/api/media/${PUBLIC})`, origin, head);
    expect(e).toBeNull(); // the FIRST audio file decides; it is not public, so none
  });

  it("only the site's own files: an audio file on another host is not an enclosure", async () => {
    expect(await firstAudioEnclosure("![x](https://cdn.example/a.mp3)", origin, async () => ({ length: 1 }))).toBeNull();
  });
});

describe("itunesChannelTags", () => {
  it("author, explicit=false and the picture when there is one", () => {
    expect(itunesChannelTags("Me", "https://example.org/logo.png", (s) => s)).toEqual([
      "    <itunes:author>Me</itunes:author>",
      "    <itunes:explicit>false</itunes:explicit>",
      '    <itunes:image href="https://example.org/logo.png"/>',
    ]);
    expect(itunesChannelTags("Me", undefined, (s) => s)).toHaveLength(2);
  });
});
