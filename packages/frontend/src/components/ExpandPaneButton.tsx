import { Maximize2, Minimize2 } from "lucide-react";
import type { useExpandedPane } from "../hooks/useExpandedPane";
import { useT } from "../lib/i18n";
import "./ExpandPaneButton.css";
import { Pressable } from "./ui";

/** The one 「放大畫面」 button of every pane that can fill the window (PDF,
 *  handwriting page): `<ExpandPaneButton {...useExpandedPane(nodeId)} />`.
 *  The pane puts `pane--expanded` on its root while `expanded`. */
export default function ExpandPaneButton({ expanded, enter, exit }: ReturnType<typeof useExpandedPane>) {
  const t = useT();
  const label = expanded ? t("Shrink (Esc)") : t("Enlarge");
  return (
    <Pressable
      type="button"
      className="ink-tool-btn"
      data-pdf-expand
      aria-label={label}
      title={label}
      onClick={expanded ? exit : enter}
    >{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Pressable>
  );
}
