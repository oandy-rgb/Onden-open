import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { followDragPointer, splitDrag, useSplitDrag } from "../../lib/splitViewStore";

/** The translucent 「放在右邊」 landing shown while a view tab, a sidebar note, a
 *  top-bar function or the right pane's header is dragged. It only paints:
 *  the pointer is followed by followDragPointer (HTML5 drags) or by the
 *  source's own pointer drag (the sidebar), both ending in splitDrag. */
export default function SplitDropHint() {
  const t = useT();
  const drag = useSplitDrag();
  const live = drag !== null;
  useEffect(() => (live ? followDragPointer() : undefined), [live]);
  // Esc gives the drag up: nothing opens.
  useEscapeKey(() => { splitDrag.cancel(); }, live);
  if (!drag) return null;
  return (
    <>
      {drag.from === "right-header" ? null : (
        <div className="split-drop split-drop--right" data-active={drag.side === "right" || undefined} aria-hidden="true">
          <span>{t("Drop to open on the right")}</span>
        </div>
      )}
      {drag.from === "right-header" && (
        <div className="split-drop split-drop--left" data-active={drag.side === "left" || undefined} aria-hidden="true">
          <span>{t("Drop to read on the left")}</span>
        </div>
      )}
    </>
  );
}
