// What a captured line means, read from its words. Everything here is optional
// and never blocks saving: a reading that finds nothing, or that cannot be
// carried out (no such tag, no such note), leaves the words as typed.
//
//   #tag             an existing tag is applied to the note (a #word with no
//                    such tag stays plain text — capture never makes a tag)
//   [[note name      the capture goes under that note (up to ]] or the end of
//                    the line; found with the note search)
//   a day word + words  (明天 交報告, next Friday call Sam) one line that names a
//                    day becomes a task, as in the Tasks quick-add
//
// Pure: the reference day is a parameter. The I/O (searching, applying,
// saving) belongs to QuickCapture.

import { scanWikilinks, wikilinkTarget } from "@onden/markdown";
import { parseTaskInput, type ParsedTask } from "@onden/markdown/task-parse";

export type CaptureReading = {
  /** The text, trimmed. */
  text: string;
  /** `#paths` in the text, without the #, once each. */
  tagPaths: string[];
  /** The `[[…` token: what to search for and the exact text to take out when found. */
  link: { name: string; token: string } | null;
  /** Set when the text should be saved as a task instead of a note. */
  task: ParsedTask | null;
};

export type CaptureReadOptions = {
  /** The workspace's day and clock (lib/localDate nowDateTimeId, split). */
  today: string;
  nowTime: string;
  locale: string;
  /** The tasks module is on: without it a dated line stays a note. */
  tasksOn: boolean;
};

/** The note a `[[…` names: a closed `[[note]]` (the markdown package's own scan,
 *  so an alias or anchor is read as everywhere else), else a half-typed `[[note`
 *  running to the end of its line, which is how it is typed on a phone. */
function linkIn(text: string): CaptureReading["link"] {
  const closed = scanWikilinks(text)[0];
  if (closed) {
    const name = wikilinkTarget(closed.body);
    return name ? { name, token: text.slice(closed.start, closed.end) } : null;
  }
  const open = text.indexOf("[[");
  if (open === -1) return null;
  const lineEnd = text.indexOf("\n", open);
  const token = lineEnd === -1 ? text.slice(open) : text.slice(open, lineEnd);
  const name = token.slice(2).trim();
  return name && !name.includes("]") ? { name, token } : null;
}

export function readCapture(input: string, { today, nowTime, locale, tasksOn }: CaptureReadOptions): CaptureReading {
  const text = input.trim();
  const link = linkIn(text);
  const parsed = parseTaskInput(text, { today, nowTime, locale });
  // One line with a day in it, and no wish to file it under a note: a task.
  const task = tasksOn && !link && !text.includes("\n") && parsed.when_date !== null && parsed.title ? parsed : null;
  return { text, tagPaths: [...new Set(parsed.tags)], link, task };
}

/** The text with the `[[…` token taken out (once it has been honoured). */
export function withoutLink(text: string, token: string): string {
  return text.replace(token, "").replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "").trim();
}
