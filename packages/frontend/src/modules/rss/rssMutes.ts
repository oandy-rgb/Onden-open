import { useCallback, useEffect, useState } from "react";
import { reads, rssWriter } from "../../lib/data";

// 少看這種: hide a word (in titles) or a whole feed from your own list for a
// week. Nothing is deleted and nobody else's list changes (backend mutes.ts).

export type RssMute = {
  id: string;
  /** Set for a word. */
  keyword: string | null;
  /** Set for a feed, with its name. */
  source_id: string | null;
  source_title: string | null;
  expires_at: string;
};

/** The longest word the server takes (the server's limit, backend mutes.ts). */
export const MUTE_WORD_MAX_CHARS = 80;

/** A selection as a mute word: lines and spaces collapsed; null when it is empty or too long to be a word. */
export function muteWordOf(selection: string): string | null {
  const word = selection.replace(/\s+/g, " ").trim();
  return word.length > 0 && word.length <= MUTE_WORD_MAX_CHARS ? word : null;
}

/** Returns the mute's id (to take it back). */
export async function muteWords(keyword: string): Promise<string> {
  return (await rssWriter.muteWords(keyword)).id;
}

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
