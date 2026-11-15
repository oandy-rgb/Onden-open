import { systemLanguageTag } from "../lib/i18n";

/** What the opening screen says. Before the app's dictionary is loaded, so the two languages are written here. */
export function startingText(replay: { done: number; total: number } | null, tag: string = systemLanguageTag()): string {
  const zh = /^zh/i.test(tag);
  if (!replay || replay.total === 0) return zh ? "正在開啟 Onden 試用版…" : "Opening Onden…";
  return zh
    ? `正在恢復上次關閉前還沒存好的修改（${replay.done} / ${replay.total}）…`
    : `Restoring changes you made before the last close (${replay.done} of ${replay.total})…`;
}
