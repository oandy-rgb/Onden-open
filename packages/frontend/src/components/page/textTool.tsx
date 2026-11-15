import { Type } from "lucide-react";
import type { InkToolEntry } from "../InkToolbar";

/** The toolbar's Text tool, the same entry on every page surface (PDF, handwriting).
 *  Hosts add it after the built-in tools: `trailingTools={[TEXT_TOOL]}`. */
export const TEXT_TOOL: InkToolEntry<"text"> = {
  id: "text",
  label: "Text",
  icon: <Type size={15} />,
  hint: "Tap the page to add a text box",
};
