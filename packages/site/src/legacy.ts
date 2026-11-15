// The old home studio edits a v2-shaped working copy (a Puck home page, style,
// css, frames). These two functions are the whole bridge between it and the
// stored v3 design, so the studio needs no knowledge of boxes.
import type { PuckData, SiteDesign, SiteDesignV2 } from "./design.js";
import { defaultDesignV2, defaultFrames, type DefaultDesignInput } from "./defaults.js";
import { isDefaultHome } from "./designV3.js";

const sameContent = (a: PuckData | null, b: PuckData) => JSON.stringify(a?.content ?? []) === JSON.stringify(b.content);

/** The working copy the old studio opens: the design's `legacy_home` (or the v2 default
 *  home page when it has none), its style, css and date tags. */
export function legacyDesignOf(design: SiteDesign, fallback: DefaultDesignInput = {}): SiteDesignV2 {
  const base = defaultDesignV2(fallback);
  return {
    ...base,
    rev: design.rev,
    home: design.legacy_home ?? base.home,
    style: design.style,
    css: design.css,
    frames: { ...defaultFrames(), date_tags: design.date_tags },
  };
}

/** `design` with the studio's changes laid over it. Changing the home page makes
 *  the old free-form home page the one that is drawn (`preset: null`); until
 *  then, whatever home page style is chosen stays. */
export function withLegacyDesign(design: SiteDesign, studio: SiteDesignV2): SiteDesign {
  // Opening the studio on a site that never had a free-form home page shows the v2 default one; saving that as it is changes nothing.
  const homeChanged = !sameContent(design.legacy_home, studio.home) && !(design.legacy_home === null && isDefaultHome(studio.home));
  return {
    ...design,
    rev: studio.rev,
    legacy_home: studio.home,
    preset: homeChanged && studio.home.content.length > 0 ? null : design.preset,
    style: studio.style,
    css: studio.css,
    date_tags: studio.frames.date_tags,
  };
}
