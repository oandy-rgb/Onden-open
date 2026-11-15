import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { nearestIndex, tickIndexes, type TimelinePoint } from "../../lib/history";
import { capturePointer } from "../../lib/pointerDrag";

type Props = {
  points: TimelinePoint[];
  /** The version being looked at. */
  index: number;
  disabled?: boolean;
  ariaLabel: string;
  ariaValueText: string;
  /** The words over the thumb for a version ("Oct 20, 2:32 PM", or "Now"). */
  labelFor: (index: number) => string;
  onSeek: (index: number) => void;
};

/** The time slider. The thumb follows the pointer smoothly while the screen shows the nearest
 *  version; on release the thumb settles on that version. Keys move one version at a time. */
export function HistorySlider({ points, index, disabled = false, ariaLabel, ariaValueText, labelFor, onSeek }: Props) {
  const rail = useRef<HTMLDivElement>(null);
  // Where the pointer holds the thumb (0–1) while dragging; null when the thumb sits on a version.
  const [dragAt, setDragAt] = useState<number | null>(null);
  const last = points.length - 1;
  const settledAt = last <= 0 ? 1 : index / last;
  const at = dragAt ?? settledAt;

  const fractionOf = (e: PointerEvent) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return settledAt;
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  };
  const follow = (e: PointerEvent) => {
    const fraction = fractionOf(e);
    setDragAt(fraction);
    const next = nearestIndex(fraction, points.length);
    if (next !== index) onSeek(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    capturePointer(e.currentTarget, e.pointerId);
    follow(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (dragAt !== null) follow(e); };
  const release = () => setDragAt(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const target = e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown" ? index - 1
      : e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp" ? index + 1
      : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (target === null) return;
    e.preventDefault();
    setDragAt(null);
    onSeek(Math.min(last, Math.max(0, target)));
  };

  const ticks = tickIndexes(points.length, index);
  const thin = points.length > ticks.length;
  const shownIndex = dragAt === null ? index : nearestIndex(dragAt, points.length);

  return (
    <div className="nh-slider" data-dragging={dragAt !== null || undefined}>
      <div
        className="nh-track" role="slider" tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel} aria-orientation="horizontal" aria-disabled={disabled || undefined}
        aria-valuemin={0} aria-valuemax={last} aria-valuenow={index} aria-valuetext={ariaValueText}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      >
        <div className="nh-rail" ref={rail}>
          <div className="nh-rail-line" />
          <div className="nh-rail-fill" style={{ "--at": `${(at) * 100}%` } as CSSProperties} />
          <div className="nh-ticks" aria-hidden="true">
            {ticks.map((i) => {
              const p = points[i]!;
              const cls = ["nh-tick", p.authorKind === "agent" && "nh-tick--agent", i === last && "nh-tick--now", i <= shownIndex && "nh-tick--passed", i === shownIndex && "nh-tick--current", thin && "nh-tick--thin"];
              return <span key={p.versionId ?? "now"} className={cls.filter(Boolean).join(" ")} style={{ "--at": `${(last <= 0 ? 1 : i / last) * 100}%` } as CSSProperties} />;
            })}
          </div>
          <div className="nh-thumb" style={{ "--at": `${(at) * 100}%` } as CSSProperties} />
        </div>
      </div>
      <div className="nh-label-lane" aria-hidden="true">
        <span className="nh-label" style={{ "--at": `${(at) * 100}%` } as CSSProperties}>{labelFor(shownIndex)}</span>
      </div>
    </div>
  );
}
