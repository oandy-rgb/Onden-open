// `@onden/markdown/full`: the pipeline with KaTeX and every code grammar
// registered up front — for the server (exports, the static site), where
// rendering is synchronous and bundle size doesn't matter. The app uses
// ondenMarkdownCore with what lazy.ts has loaded instead.
import rehypeKatex from "rehype-katex";
import { createLowlight } from "lowlight";
import { ondenMarkdownCore, type OndenMarkdown, type OndenMarkdownOptions } from "./index.js";
import { registerMoreGrammars } from "./highlight.js";
import * as moreTable from "./grammarTableMore.generated.js";
import { fullGrammars } from "./fullGrammars.js";
import { withNodeText } from "./lowlightCore.js";

registerMoreGrammars(moreTable);
const lowlight = withNodeText(createLowlight(fullGrammars()));
const grammars = new Set<string>(lowlight.listLanguages());

export function ondenMarkdown(options: OndenMarkdownOptions): OndenMarkdown {
  return ondenMarkdownCore(options, { highlight: { lowlight, grammars, detect: true }, katex: rehypeKatex });
}
