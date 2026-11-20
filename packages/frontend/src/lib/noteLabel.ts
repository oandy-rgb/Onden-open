// The name a list shows for a note. A note nobody titled is stored with the
// placeholder title ("Untitled" / 「未命名」) — or none — while its text may
// already say what it is; lists show the text's first line then, so notes can
// be told apart (offline too). Only the display changes: the stored title is
// left alone, and a note whose body is not loaded keeps its title.
import { t } from "./i18n";

import { ellipsize, plainInline, stripLineMarker } from "@onden/markdown";
const MAX_LABEL = 60;
const PLACEHOLDER_TITLES = ["Untitled", "未命名"];
const PLACEHOLDER_NAMES: Record<string, string> = { "zh-TW": "未命名", ja: "無題" };

/** What a published site calls a note with no title and no text, in the site's language (the app uses `untitledTitle`). */
export function placeholderName(siteLocale: string | undefined): string {
  return PLACEHOLDER_NAMES[siteLocale ?? "zh-TW"] ?? "Untitled";
}

type Labelled = { title: string; markdown?: string };

/** The first line with some text, minus the markup in front of it. */
export function firstLine(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = plainInline(stripLineMarker(raw)).trim();
    if (line) return ellipsize(line, MAX_LABEL);
  }
  return "";
}

/** The stored title of a note nobody has named yet, and what lists call it. */
export function untitledTitle(): string {
  return t("Untitled");
}

/** What a list shows for a note (or tag) that has this name: the name, or
 *  「未命名」 when it is blank. The ONE place that decides this; a surface that
 *  can also see the note's text uses noteLabel, which falls back to this. */
export function displayTitle(title: string | null | undefined): string {
  return title && title.trim() ? title : untitledTitle();
}

/** Whether a stored title is only the placeholder of a note nobody named. The
 *  editor shows such a title as an empty field (grey 「未命名」 placeholder),
 *  not as text the writer would have to delete first. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const trimmed = (title ?? "").trim();
  // The stored placeholder is the creating device's language, so both are placeholders whatever language this page reads in.
  return !trimmed || PLACEHOLDER_TITLES.includes(trimmed) || trimmed === t("Untitled");
}

export function noteLabel(node: Labelled): string {
  if (!isPlaceholderTitle(node.title)) return node.title;
  return firstLine(node.markdown ?? "") || displayTitle(node.title);
}
