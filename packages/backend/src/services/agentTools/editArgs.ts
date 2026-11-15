import { z } from "zod";
import { NODE_MARKDOWN_MAX, NODE_TITLE_MAX } from "../../utils.js";

// updateNode and suggestEdit take the same edit. REST and tools share the complete edit operation, dry run included
// (services/nodeUpdate.ts): the tool exposes only the title/body subset, with
// the same size caps as REST. Dry-run is an authorized preview, not a reservation.
//
// A body write is three-way, as the app's editors are (D87): the agent sends
// the markdown it read (getNode) as base_markdown, so lines someone else
// changed since then survive. Without a base the tool would replace the whole
// body with a copy that may be minutes old and silently drop those edits, so
// a body without a base is refused (invalid_args) instead of guessed at.
export const EditArgs = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(NODE_TITLE_MAX).optional(),
  markdown: z.string().max(NODE_MARKDOWN_MAX).optional(),
  base_markdown: z.string().max(NODE_MARKDOWN_MAX).optional(),
}).refine(
  (v) => v.title !== undefined || v.markdown !== undefined,
  { message: "must provide title or markdown" },
).refine(
  (v) => v.markdown === undefined || v.base_markdown !== undefined,
  {
    message: "markdown needs base_markdown: call getNode and pass the markdown it returned, " +
      "unchanged, as base_markdown, so edits made since you read the note are kept",
    path: ["base_markdown"],
  },
);

