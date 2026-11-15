import { describe, expect, it } from "vitest";
import { liteEmbedHast, liteEmbedOf, YOUTUBE_THUMB_HOST } from "./liteEmbed.js";
import { toEmbedUrl } from "./mediaEmbed.js";
import { AUDIO_SPEEDS, audioSpeedLabel, litePlaySrc, nextAudioSpeed } from "./mediaMarkup.js";

describe("liteEmbedOf", () => {
  it("YouTube: a thumbnail from i.ytimg.com (the one image host) and a link to the video", () => {
    const lite = liteEmbedOf(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ")!)!;
    expect(lite.thumbUrl).toBe(`https://${YOUTUBE_THUMB_HOST}/vi/dQw4w9WgXcQ/hqdefault.jpg`);
    expect(lite.watchUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(lite.frameSrc).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("Vimeo: no thumbnail (it needs their API), a neutral box with the domain", () => {
    const lite = liteEmbedOf("https://player.vimeo.com/video/76979871")!;
    expect(lite).toMatchObject({ thumbUrl: null, host: "vimeo.com", watchUrl: "https://vimeo.com/76979871" });
  });

  it("anything off the allowlist has no lite form", () => {
    expect(liteEmbedOf("https://evil.example/embed/abcdef12")).toBeNull();
    expect(liteEmbedOf("https://www.youtube-nocookie.com/embed/<script>")).toBeNull();
  });

  it("the markup is a link to the video, so it still works with no script", () => {
    const tree = JSON.stringify(liteEmbedHast(liteEmbedOf("https://player.vimeo.com/video/76979871")!, "Talk"));
    expect(tree).toContain('"href":"https://vimeo.com/76979871"');
    expect(tree).toContain('"ariaLabel":"Talk"');
    expect(tree).toContain('"tagName":"template"'); // the player waits there, inert, for the page script
  });
});

describe("audio speed", () => {
  it("cycles 1× → 1.25× → 1.5× → 2× → 1×; an unknown speed starts over", () => {
    const seen = [1];
    for (let i = 0; i < AUDIO_SPEEDS.length; i++) seen.push(nextAudioSpeed(seen.at(-1)!));
    expect(seen.map(audioSpeedLabel)).toEqual(["1×", "1.25×", "1.5×", "2×", "1×"]);
    expect(nextAudioSpeed(0.75)).toBe(1);
  });
});

describe("litePlaySrc", () => {
  it("adds autoplay with ? or & depending on the address", () => {
    expect(litePlaySrc("https://www.youtube-nocookie.com/embed/abc")).toBe("https://www.youtube-nocookie.com/embed/abc?autoplay=1");
    expect(litePlaySrc("https://player.vimeo.com/video/1?h=x")).toBe("https://player.vimeo.com/video/1?h=x&autoplay=1");
  });
});
