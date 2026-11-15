import { useState } from "react";
import { readDisplaySettings, withDisplaySettings, type CardDisplaySettings } from "../lib/cardDisplay";
import { useBoardTabSetting, type BoardTabSetting } from "./useBoardTabSetting";

const UNSET: CardDisplaySettings = {};
const DISPLAY: BoardTabSetting<CardDisplaySettings> = { read: readDisplaySettings, write: withDisplaySettings };

/**
 * How the open board draws its cards (lib/cardDisplay). A note's board keeps it
 * in its whiteboard tab; a tag's board has no tab, so its choices last until
 * the page is left (as 「精簡卡片」 always did there).
 */
export function useBoardDisplaySettings(canvasId: string | null, noteBoardId: string | null) {
  const stored = useBoardTabSetting(noteBoardId, DISPLAY);
  const [session, setSession] = useState<{ canvasId: string; settings: CardDisplaySettings } | null>(null);
  if (noteBoardId) return stored;
  const settings = session && session.canvasId === canvasId ? session.settings : UNSET;
  return { settings, save: (next: CardDisplaySettings) => { if (canvasId) setSession({ canvasId, settings: next }); } };
}
