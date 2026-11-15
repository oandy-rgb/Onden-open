// The embed allowlist is the security boundary for <iframe>: the sanitize schema only
// limits the URL scheme, so these functions decide which hosts a note may frame
// (mediaEmbed.ts). The tests state the decisions, not the implementation.

import { describe, expect, it } from "vitest";
import { classifyMedia, EMBED_IFRAME_SANDBOX, isAllowedEmbedSrc, toEmbedUrl, TRUSTED_EMBED_HOSTS } from "./mediaEmbed.js";
import { EMBED_IFRAME_ALLOW, rehypeMediaSvgLinks } from "./embedFrame.js";
import { SAFE_DATA_MEDIA_SRC } from "./urlSchemes.js";

describe("isAllowedEmbedSrc", () => {
  it.each([
    "https://youtube.com/embed/abcdefghijk",
    "https://www.youtube.com/embed/abcdefghijk",
    "https://www.youtube-nocookie.com/embed/abcdefghijk",
    "https://player.vimeo.com/video/123456",
    "https://vimeo.com/123456",
    "https://sub.domain.vimeo.com/x",
    "//www.youtube.com/embed/abcdefghijk",
    "HTTPS://WWW.YOUTUBE.COM/embed/abcdefghijk",
  ])("frames %s", (src) => {
    expect(isAllowedEmbedSrc(src)).toBe(true);
  });

  it("frames every trusted host itself and its subdomains", () => {
    for (const host of TRUSTED_EMBED_HOSTS) {
      expect(isAllowedEmbedSrc(`https://${host}/x`), host).toBe(true);
      expect(isAllowedEmbedSrc(`https://a.${host}/x`), `a.${host}`).toBe(true);
    }
  });

  it.each([
    ["an unknown https host", "https://evil.example/embed/abcdefghijk"],
    ["a host that only ends with a trusted name", "https://evilyoutube.com/embed/abcdefghijk"],
    ["a host that only ends with a trusted name (vimeo)", "https://notvimeo.com/1"],
    ["a trusted name used as a subdomain of another site", "https://youtube.com.evil.example/embed/abcdefghijk"],
    ["a trusted name before an @ (the real host is after it)", "https://youtube.com@evil.example/embed/abcdefghijk"],
    ["a trusted name in the path", "https://evil.example/youtube.com/embed/abcdefghijk"],
    ["plain http", "http://www.youtube.com/embed/abcdefghijk"],
    ["a javascript: url", "javascript:alert(1)//youtube.com"],
    ["a data: url", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative url on an unknown host", "//evil.example/x"],
    ["text that is not a url", "youtube.com/embed/abcdefghijk"],
    ["an empty string", ""],
  ])("refuses %s", (_what, src) => {
    expect(isAllowedEmbedSrc(src)).toBe(false);
  });

  it("refuses null and undefined", () => {
    expect(isAllowedEmbedSrc(null)).toBe(false);
    expect(isAllowedEmbedSrc(undefined)).toBe(false);
  });
});

describe("toEmbedUrl", () => {
  const ID = "dQw4w9WgXcQ";
  const player = `https://www.youtube-nocookie.com/embed/${ID}`;

  it("turns every YouTube form into the no-cookie player", () => {
    expect(toEmbedUrl(`https://youtu.be/${ID}`)).toBe(player);
    expect(toEmbedUrl(`https://youtu.be/${ID}/extra`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${ID}`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${ID}&t=10`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube.com/embed/${ID}`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube.com/embed/${ID}?start=3`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube.com/shorts/${ID}`)).toBe(player);
    expect(toEmbedUrl(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(player);
    expect(toEmbedUrl(`//www.youtube.com/watch?v=${ID}`)).toBe(player);
  });

  it("gives no player for a YouTube url without a usable video id", () => {
    expect(toEmbedUrl("https://youtu.be/")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/watch")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/watch?v=" + "a".repeat(16))).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/watch?v=ab/cd\"onload=1")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/embed/")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/shorts/")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/channel/UC12345678901")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/")).toBeNull();
  });

  it("accepts the shortest and longest video id, no more", () => {
    expect(toEmbedUrl("https://youtu.be/abcdef")).toBe("https://www.youtube-nocookie.com/embed/abcdef");
    expect(toEmbedUrl("https://youtu.be/" + "a".repeat(15))).toBe(`https://www.youtube-nocookie.com/embed/${"a".repeat(15)}`);
    expect(toEmbedUrl("https://youtu.be/abcde")).toBeNull();
  });

  it("turns Vimeo urls into the player and refuses a non-numeric id", () => {
    expect(toEmbedUrl("https://vimeo.com/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://vimeo.com/123456/abcdef")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://player.vimeo.com/video/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://player.vimeo.com/video/123456?h=abc")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://vimeo.com/channels/staffpicks")).toBeNull();
    expect(toEmbedUrl("https://vimeo.com/12ab")).toBeNull();
    expect(toEmbedUrl("https://vimeo.com/")).toBeNull();
    expect(toEmbedUrl("https://player.vimeo.com/video/abc")).toBeNull();
    expect(toEmbedUrl("https://player.vimeo.com/video/")).toBeNull();
  });

  it("a Vimeo id is digits only, wherever the digits sit in the path", () => {
    for (const bad of ["https://vimeo.com/ab12", "https://vimeo.com/12ab", "https://player.vimeo.com/video/ab12", "https://player.vimeo.com/video/12ab"]) {
      expect(toEmbedUrl(bad), bad).toBeNull();
    }
  });

  it("only player.vimeo.com has a /video/ form; other Vimeo paths are the bare id", () => {
    expect(toEmbedUrl("https://player.vimeo.com/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://vimeo.com/video/123456")).toBeNull();
  });

  it("a YouTube path that is not watch, embed, shorts or a short link gives no player, however it is shaped", () => {
    expect(toEmbedUrl("https://www.youtube.com/12345678dQw4w9WgXcQ")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBeNull();
    expect(toEmbedUrl("https://www.youtube.com/v/dQw4w9WgXcQ")).toBeNull();
  });

  it("a numeric path on a host that is neither YouTube nor Vimeo is not a player", () => {
    expect(toEmbedUrl("https://example.com/123456")).toBeNull();
    expect(toEmbedUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(classifyMedia("https://example.com/123456")).toBeNull();
  });

  it("gives nothing for other hosts, schemes and empty input", () => {
    expect(toEmbedUrl("https://evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(toEmbedUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(toEmbedUrl("https://example.com/")).toBeNull();
    expect(toEmbedUrl("")).toBeNull();
    expect(toEmbedUrl(null)).toBeNull();
    expect(toEmbedUrl(undefined)).toBeNull();
    expect(toEmbedUrl("not a url")).toBeNull();
  });

  it("never returns a url on a host outside the trusted providers, whatever the input host", () => {
    const hosts = ["evilyoutube.com", "youtube.com.evil.example", "xvimeo.com", "evil-youtube-nocookie.com", "youtu.be.evil.example"];
    for (const host of hosts) {
      for (const path of ["/watch?v=dQw4w9WgXcQ", "/dQw4w9WgXcQ", "/embed/dQw4w9WgXcQ", "/123456"]) {
        const out = toEmbedUrl(`https://${host}${path}`);
        if (out !== null) expect(isAllowedEmbedSrc(out), `${host}${path} -> ${out}`).toBe(true);
      }
    }
  });
});

describe("classifyMedia", () => {
  it("sorts a file by what it is and a provider url as an iframe", () => {
    expect(classifyMedia("https://cdn.example/a.mp4")).toBe("video");
    expect(classifyMedia("https://cdn.example/a.webm")).toBe("video");
    expect(classifyMedia("https://cdn.example/a.mp3")).toBe("audio");
    expect(classifyMedia("https://cdn.example/a.ogg")).toBe("audio");
    expect(classifyMedia("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("iframe");
    expect(classifyMedia("https://vimeo.com/123456")).toBe("iframe");
  });

  it("leaves images, documents, other pages and empty input to the caller", () => {
    expect(classifyMedia("https://cdn.example/a.png")).toBeNull();
    expect(classifyMedia("https://cdn.example/a.pdf")).toBeNull();
    expect(classifyMedia("https://example.com/page")).toBeNull();
    expect(classifyMedia("https://www.youtube.com/channel/x")).toBeNull();
    expect(classifyMedia("")).toBeNull();
    expect(classifyMedia(null)).toBeNull();
    expect(classifyMedia(undefined)).toBeNull();
  });
});

describe("EMBED_IFRAME_SANDBOX", () => {
  it("is the minimum a video player needs and never allows the framed page into our origin", () => {
    expect(EMBED_IFRAME_SANDBOX.split(" ").sort()).toEqual(["allow-popups", "allow-presentation", "allow-scripts"]);
    expect(EMBED_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });
});

describe("SAFE_DATA_MEDIA_SRC", () => {
  it("lets inline image, audio and video through, in any letter case", () => {
    for (const src of ["data:image/png;base64,AAAA", "data:audio/mpeg;base64,AAAA", "data:video/mp4;base64,AAAA", "DATA:IMAGE/PNG;base64,AAAA"]) {
      expect(SAFE_DATA_MEDIA_SRC.test(src), src).toBe(true);
    }
  });

  it("refuses active content and anything that only contains such a prefix", () => {
    for (const src of [
      "data:text/html,<script>alert(1)</script>",
      "data:application/javascript,alert(1)",
      "data:image",
      "data:imagefoo/png",
      "javascript:alert(1)//data:image/png",
      " data:image/png;base64,AAAA",
      "https://evil.example/?u=data:image/png",
    ]) {
      expect(SAFE_DATA_MEDIA_SRC.test(src), src).toBe(false);
    }
  });
});

describe("embed hosts sit on a dot boundary", () => {
  it("rejects a host that only ends like a trusted one", () => {
    for (const src of [
      "https://evilvimeo.com/123456",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://evilyoutube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://evilplayer.vimeo.com.example/video/123",
    ]) {
      expect(toEmbedUrl(src), src).toBeNull();
      expect(isAllowedEmbedSrc(src), src).toBe(false);
    }
  });

  it("still accepts the providers and their subdomains", () => {
    expect(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://vimeo.com/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(toEmbedUrl("https://player.vimeo.com/video/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(isAllowedEmbedSrc("https://player.vimeo.com/video/1")).toBe(true);
  });
});

describe("embed constants shared by the site and the exports", () => {
  it("rehypeMediaSvgLinks turns a link to an uploaded SVG into a picture and leaves other links alone", () => {
    const a = (href: string) => ({ type: "element" as const, tagName: "a", properties: { href }, children: [{ type: "text" as const, value: "diagram" }] });
    const tree = { type: "root" as const, children: [
      { type: "element" as const, tagName: "p", properties: {}, children: [a("/media/a.svg"), a("/media/a.png"), a("https://x.test/a.svg")] },
    ] };
    rehypeMediaSvgLinks()(tree);
    const kids = (tree.children[0] as { children: { tagName: string; properties: Record<string, unknown> }[] }).children;
    expect(kids.map((k) => k.tagName)).toEqual(["img", "a", "a"]);
    expect(kids[0]!.properties).toMatchObject({ src: "/media/a.svg", alt: "diagram", loading: "lazy" });
  });

  it("the allow string grants playback features and never camera, microphone or geolocation", () => {
    expect(EMBED_IFRAME_ALLOW).toContain("fullscreen");
    expect(EMBED_IFRAME_ALLOW).not.toMatch(/camera|microphone|geolocation/);
  });
});
