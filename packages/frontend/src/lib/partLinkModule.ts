import { useEffect, useState, useSyncExternalStore } from "react";
import { anchorsVersion, watchAnchors } from "./blockAnchorStore";

// The reading of `[[筆記/段落]]` (lib/blockLinks.ts, over @onden/markdown blockLink.ts) loads when a note holds something that
// may be such a link, not with the app: most notes hold none. Whoever draws links asks `usePartLinks(text)`; it answers null
// until the module is here and then draws again, so a link first shows as the text it was written with and then as
// 「筆記 › 開頭」. The editor and its embeds import lib/blockLinks themselves (they are loaded on use already).

type PartLinks = typeof import("./blockLinks");
let loaded: PartLinks | null = null;
let loading: Promise<void> | null = null;

/** The module when it is already here (null before anything asked for it). */
export const loadedPartLinks = (): PartLinks | null => loaded;

export const loadPartLinks = (): Promise<void> => loading ??= import("./blockLinks").then((m) => { loaded = m; });

// A `[[…]]` and a `/` (a part link `[[Note/words]]`, its embed `![[…]]`) or a `#^` (an old `[[Note#^id]]`) in the text: a cheap guess,
// which only decides whether the module is fetched (once; it is kept), never what a link means.
export const mayHavePartLinks = (markdown: string): boolean => markdown.includes("[[") && (markdown.includes("/") || markdown.includes("#^"));

/** The part-link reading for a screen that draws `markdown`, or null while it loads / when the text has no such link.
 *  Also redraws when an anchor or binding arrives. */
export function usePartLinks(markdown: string, enabled = true): PartLinks | null {
  const [, bump] = useState(0);
  const wanted = enabled && mayHavePartLinks(markdown);
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    void loadPartLinks().then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [wanted]);
  useSyncExternalStore(watchAnchors, anchorsVersion, anchorsVersion);
  return wanted ? loaded : null;
}
