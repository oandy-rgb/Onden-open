import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/keys";
import { capturePointer } from "../../lib/pointerDrag";
import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from "../../lib/splitView";
import { commitRatio, setRatio } from "../../lib/splitViewStore";

/** The draggable edge between the two sides. It sets the left side's share of
 *  the width; the arrow keys step it. */
export default function SplitDivider({ ratio, container }: { ratio: number; container: () => HTMLElement | null }) {
  const t = useT();
  const dragging = useRef(false);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = container()?.getBoundingClientRect();
    if (!dragging.current || !box || box.width <= 0) return;
    setRatio((event.clientX - box.left) / box.width);
  };
  const end = () => { if (dragging.current) { dragging.current = false; commitRatio(); } };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    const step = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    setRatio(ratio + step);
    commitRatio();
  };
  return (
    <div className="split-divider" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t("Resize the two sides")} aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)} aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); capturePointer(event.currentTarget, event.pointerId); dragging.current = true; }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={onKeyDown} />
  );
}
