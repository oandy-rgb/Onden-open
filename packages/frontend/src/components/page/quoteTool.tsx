import { BoxSelect } from "lucide-react";
import type { InkToolEntry } from "../InkToolbar";

/** The toolbar's 「引用」 tool on a handwriting page: drag a frame over an area of the page, then copy a
 *  reference to it that any note can embed. Added after the built-in tools: `trailingTools={[TEXT_TOOL, QUOTE_TOOL]}`. */
export const QUOTE_TOOL: InkToolEntry<"quote"> = {
  id: "quote",
  label: "Quote",
  icon: <BoxSelect size={15} />,
  hint: "Drag a frame over an area, then copy a reference to paste into any note",
};
