// What a published page does with its media once a script runs: a lite embed
// (liteEmbed.ts) becomes its iframe when pressed, and the audio speed button
// cycles the player's speed. Plain DOM code with no framework, loaded on
// demand (lazy.ts loadMediaEnhancer) by the site's pages, which only fetch it
// when the page has such an element. The app draws the same markup with React
// and does not use this.
//
// Without script both stay what the markup is: the thumbnail is a link to the
// video, and the speed button stays `hidden`.

import { AUDIO_SPEED_ATTR, LITE_EMBED_CLASS, LITE_EMBED_LINK_CLASS, audioSpeedLabel, litePlaySrc, nextAudioSpeed } from "./mediaMarkup.js";

/** Press on a lite embed: swap its thumbnail for the iframe its <template>
 *  carries (made and gated at render, liteEmbed.ts). False when it carries
 *  none, so the link then does its plain job. */
export function playLiteEmbed(embed: HTMLElement): boolean {
  const frame = embed.querySelector("template")?.content.querySelector("iframe");
  if (!frame?.getAttribute("src")?.startsWith("https://")) return false;
  const playing = embed.ownerDocument.importNode(frame, true);
  playing.setAttribute("src", litePlaySrc(frame.getAttribute("src")!));
  embed.className = "md-embed md-embed-iframe";
  embed.replaceChildren(playing);
  playing.focus();
  return true;
}

/** Press on a speed button: the audio just before it takes the next speed. */
export function cycleAudioSpeed(button: HTMLElement): void {
  const audio = button.previousElementSibling;
  if (!(audio instanceof HTMLAudioElement)) return;
  audio.playbackRate = nextAudioSpeed(audio.playbackRate);
  button.textContent = audioSpeedLabel(audio.playbackRate);
}

const wired = new WeakSet<Document>();

/** Wire `doc`: one delegated click handler (once per document, however often
 *  this is called), and the speed buttons shown (they are `hidden` in the
 *  markup, as a button that does nothing without script). */
export function installMediaEnhancer(doc: Document = document): void {
  for (const button of doc.querySelectorAll<HTMLElement>(`[${AUDIO_SPEED_ATTR}]`)) button.hidden = false;
  if (wired.has(doc)) return;
  wired.add(doc);
  doc.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const speed = target?.closest<HTMLElement>(`[${AUDIO_SPEED_ATTR}]`);
    if (speed) { cycleAudioSpeed(speed); return; }
    const link = target?.closest(`.${LITE_EMBED_CLASS} .${LITE_EMBED_LINK_CLASS}`);
    const embed = link?.closest<HTMLElement>(`.${LITE_EMBED_CLASS}`);
    // A new-tab / modified click keeps the link's own meaning.
    if (!embed || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (playLiteEmbed(embed)) event.preventDefault();
  });
}
