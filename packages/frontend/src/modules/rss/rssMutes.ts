import { useCallback, useEffect, useState } from "react";
import { reads, rssWriter } from "../../lib/data";

// Hide a whole feed from your own list for a week. Nothing is deleted and nobody else's list changes (backend mutes.ts).
// Word mutes made earlier (the selection's 「少看這種」, dropped 2026-11-20: owner 「幫助不是太大」) still show in the
// sources sheet so they can be taken back, and expire on their own.

export type RssMute = {
  id: string;
  /** Set for a word. */
  keyword: string | null;
  /** Set for a feed, with its name. */
  source_id: string | null;
  source_title: string | null;
  expires_at: string;
};

export async function muteFeed(sourceId: string): Promise<string> {
  return (await rssWriter.muteFeed(sourceId)).id;
}

export async function unmute(id: string): Promise<void> {
  await rssWriter.unmute(id);
}

/** The active mutes (null while loading or when they could not be read). */
export function useRssMutes(): { mutes: RssMute[] | null; reload: () => Promise<void> } {
  const [mutes, setMutes] = useState<RssMute[] | null>(null);
  const reload = useCallback(async () => {
    try { setMutes((await reads.modules.rss.mutes<{ mutes: RssMute[] }>()).mutes); } catch { /* offline: keep what is shown */ }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { mutes, reload };
}
