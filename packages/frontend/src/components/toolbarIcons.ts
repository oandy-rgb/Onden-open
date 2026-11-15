import {
  Bold, Code, FileInput, FileOutput, ClipboardCopy, Hash, Heading1, Heading2, Heading3, Highlighter, History, ImagePlus, Italic,
  Link, Link2, List, ListChecks, ListOrdered, ListTodo, Quote, Sparkles, Strikethrough, Underline, type LucideIcon,
} from "lucide-react";

/** The icon of each toolbar button (ids: lib/toolbarLayout). One place, so the
 *  bars and Settings › 工具列 draw the same button the same way. */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  tag: Hash,
  ai: Sparkles,
  wikilink: Link2,
  insertFile: ImagePlus,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  underline: Underline,
  highlight: Highlighter,
  code: Code,
  link: Link,
  bullet: List,
  number: ListOrdered,
  task: ListChecks,
  quote: Quote,
  toChild: FileOutput,
  copyLink: ClipboardCopy,
  history: History,
  convertTask: ListTodo,
  expand: FileInput,
};
