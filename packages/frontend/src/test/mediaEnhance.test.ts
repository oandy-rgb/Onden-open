// The page script of the published site (@onden/markdown mediaEnhance.ts): what
// a press on a lite embed and on the audio speed button does to the DOM.
import { afterEach, describe, expect, it } from "vitest";
import { installMediaEnhancer, playLiteEmbed } from "@onden/markdown/media-enhance";

const FRAME = `<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Talk" sandbox="allow-scripts allow-presentation allow-popups" loading="lazy"></iframe>`;
const LITE = `<p><span class="md-embed md-embed-lite">
  <a class="md-lite-link" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" aria-label="Talk"><span class="md-lite-play"></span></a><template>${FRAME}</template></span></p>`;
const AUDIO = `<p><audio class="md-audio" src="/a.mp3" controls></audio><button type="button" class="md-audio-speed" data-audio-speed hidden>1×</button></p>`;

afterEach(() => { document.body.innerHTML = ""; });

describe("lite embed", () => {
  it("a press swaps the thumbnail for a sandboxed iframe and stops the link from navigating", () => {
    document.body.innerHTML = LITE;
    installMediaEnhancer(document);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.querySelector(".md-lite-link")!.dispatchEvent(click);
    const frame = document.querySelector("iframe")!;
    expect(click.defaultPrevented).toBe(true);
    expect(frame.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-presentation allow-popups");
    expect(frame.title).toBe("Talk");
    expect(document.querySelector(".md-lite-link")).toBeNull();
  });

  it("a modified click is left to the link (new tab)", () => {
    document.body.innerHTML = LITE;
    installMediaEnhancer(document);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    document.querySelector(".md-lite-link")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("an embed that carries no https iframe is not played: the link keeps its job", () => {
    document.body.innerHTML = LITE.replace(/<template>.*<\/template>/, "");
    expect(playLiteEmbed(document.querySelector<HTMLElement>(".md-embed-lite")!)).toBe(false);
    document.body.innerHTML = LITE.replace("https://www.youtube-nocookie", "javascript:void(0)//www.youtube-nocookie");
    expect(playLiteEmbed(document.querySelector<HTMLElement>(".md-embed-lite")!)).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("audio speed", () => {
  it("is shown once the script runs, and each press takes the next speed", () => {
    document.body.innerHTML = AUDIO;
    const button = document.querySelector<HTMLElement>("[data-audio-speed]")!;
    const audio = document.querySelector("audio")!;
    expect(button.hidden).toBe(true);
    installMediaEnhancer(document);
    expect(button.hidden).toBe(false);
    const labels: string[] = [];
    for (let i = 0; i < 4; i++) { button.click(); labels.push(`${button.textContent}@${audio.playbackRate}`); }
    expect(labels).toEqual(["1.25×@1.25", "1.5×@1.5", "2×@2", "1×@1"]);
  });
});

describe("a note cannot write its own lite embed", () => {
  const raw = '<span class="md-embed-lite"><a class="md-lite-link" href="https://evil.example">x</a><template><iframe src="https://evil.example/x"></iframe></template></span>';

  it("on the site, raw HTML with the embed's class and a <template> iframe is stripped by the sanitizer, so the script has nothing of an author's to play", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { loadAllEnhancers } = await import("@onden/markdown");
    const { makeSiteMarkdown } = await import("../components/siteFrame/siteMarkdown");
    await loadAllEnhancers();
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(makeSiteMarkdown([])(raw, null) as never);
    expect(root.querySelector("template, iframe, .md-embed-lite")).toBeNull();
  });

  it("in the exports, raw HTML is shown as text, never as markup", async () => {
    const { md2html } = await import("../../../backend/src/modules/website/publishing/htmlUtils");
    const root = document.createElement("div");
    root.innerHTML = md2html(raw);
    expect(root.querySelector("template, iframe, .md-embed-lite")).toBeNull();
  });
});
