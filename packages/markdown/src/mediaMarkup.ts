// The names and values the media markup and its page script (mediaEnhance.ts)
// share: the audio speed button's list and cycle, the lite embed's class names
// and play address. A leaf with no imports on purpose: the script is
// loaded alone by the site's pages, and anything it imports from the app's
// boot JS would become a chunk both have to fetch.

export const AUDIO_SPEEDS = [1, 1.25, 1.5, 2] as const;

/** The speed after `current` in the cycle (an unknown speed starts over at 1×). */
export function nextAudioSpeed(current: number): number {
  const at = AUDIO_SPEEDS.indexOf(current as (typeof AUDIO_SPEEDS)[number]);
  return AUDIO_SPEEDS[(at + 1) % AUDIO_SPEEDS.length]!;
}

/** `1.25` → "1.25×". */
export const audioSpeedLabel = (speed: number): string => `${speed}×`;

/** The class and attribute the speed button is found by. */
export const AUDIO_SPEED_CLASS = "md-audio-speed";
export const AUDIO_SPEED_ATTR = "data-audio-speed";

/** The src of a lite embed's iframe once pressed: the same address asking the
 *  host to start playing. The one place this is spelled (the app's React embed
 *  and the published pages' script both use it). */
export function litePlaySrc(src: string): string {
  return `${src}${src.includes("?") ? "&" : "?"}autoplay=1`;
}

export const LITE_EMBED_CLASS = "md-embed-lite";
export const LITE_EMBED_LINK_CLASS = "md-lite-link";
export const LITE_EMBED_THUMB_CLASS = "md-lite-thumb";
export const LITE_EMBED_HOST_CLASS = "md-lite-host";
export const LITE_EMBED_PLAY_CLASS = "md-lite-play";
