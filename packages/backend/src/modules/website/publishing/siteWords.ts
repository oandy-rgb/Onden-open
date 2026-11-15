// The few sentences the static exports write into a page themselves (not the
// note's own text), in the site's language (SiteLocale; any other → English).
// One table, so a new language or wording is one edit.
import { EMBED_DEFAULT_TITLE } from "@onden/markdown";

type Words = {
  /** Title of an embedded video/page that has no alt text. */
  embedTitle: string;
  /** The audio speed button's aria-label. */
  playbackSpeed: string;
  /** A video left out of the static copy: the link to the original site. */
  videoTooLargeLink: string;
  /** The same, for a site with no address to link to. */
  videoTooLargeNoLink: string;
};

const ENGLISH: Words = {
  embedTitle: EMBED_DEFAULT_TITLE,
  playbackSpeed: "Playback speed",
  videoTooLargeLink: "This video is too large — watch it on the original site",
  videoTooLargeNoLink: "This video is too large to play in this copy",
};

const BY_LOCALE: Record<string, Words> = {
  "zh-TW": {
    embedTitle: "嵌入媒體",
    playbackSpeed: "播放速度",
    videoTooLargeLink: "這部影片太大，在原站觀看",
    videoTooLargeNoLink: "這部影片太大，這個版本無法播放",
  },
  ja: {
    embedTitle: "埋め込みメディア",
    playbackSpeed: "再生速度",
    videoTooLargeLink: "この動画は大きすぎます。元のサイトで見る",
    videoTooLargeNoLink: "この動画は大きすぎて、このコピーでは再生できません",
  },
};

export const siteWords = (locale: string | undefined): Words => BY_LOCALE[locale ?? ""] ?? ENGLISH;
