import type { PuckComponentData, SiteDesignV2, SiteFrames } from "./design.js";
import { DEFAULT_ACCENT } from "./style.js";

export const ARTICLE_FRAME_KEYS = ["nav", "cover", "date", "tags", "card", "backlinks", "prevnext", "toc", "tree", "footer", "preview", "readingTime"] as const;
export const TAG_FRAME_KEYS = ["nav", "description", "footer"] as const;
/** Off unless the owner turns them on: the tag card needs public tag fields (later), the tree is a heavy left column. */
const FRAME_OFF = new Set(["card", "tree"]);
export const DEFAULT_DATE_TAGS = ["文章"];

export function defaultFrames(): SiteFrames {
  return {
    article: Object.fromEntries(ARTICLE_FRAME_KEYS.map((k) => [k, !FRAME_OFF.has(k)])),
    tag: Object.fromEntries(TAG_FRAME_KEYS.map((k) => [k, true])),
    date_tags: [...DEFAULT_DATE_TAGS],
  };
}

export type DefaultDesignInput = { homeNoteId?: string | null; topTagId?: string | null };

/** The design a workspace has until the owner makes one (design doc §5.4):
 *  the home note's first paragraph as the cover, below it a list of the tag
 *  with the most articles. Publishing never needs a layout first. A missing
 *  note or tag leaves its block out. */
export function defaultDesignV2({ homeNoteId, topTagId }: DefaultDesignInput = {}): SiteDesignV2 {
  const content: PuckComponentData[] = [];
  const partProps = { bg: "none", heading: "auto", cls: "", css: "" };
  if (homeNoteId) {
    content.push({
      type: "cover",
      props: {
        id: "default-cover", height: "m", ...partProps,
        items: [{ type: "note", props: { id: "default-home-note", noteId: homeNoteId, blockId: "", display: "first" } }],
      },
    });
  }
  if (topTagId) {
    content.push({
      type: "stack",
      props: {
        id: "default-list", ...partProps,
        items: [{ type: "tag_view", props: { id: "default-top-tag", tagId: topTagId, viewId: "", viewKind: "list", limit: 12, sort: "new" } }],
      },
    });
  }
  return {
    v: 2,
    rev: "",
    studio_draft: true,
    home: { root: { props: {} }, content },
    style: { preset: "quiet", accent: DEFAULT_ACCENT, scheme: "system" },
    css: "",
    frames: defaultFrames(),
  };
}
