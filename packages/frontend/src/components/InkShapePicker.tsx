import { INK_SHAPE_FILL_ALPHA, INK_SHAPE_KINDS, inkShapeIsFilled, inkShapePathD, type InkShapeFill, type InkShapeKind } from "@onden/markdown/ink";
import { useState } from "react";
import { useT } from "../lib/i18n";
import { Popover, Pressable, usePopover } from "./ui";

// The shape tool's one button: it shows the shape last used (so the icon is
// the answer to "what will I draw"), and opens the eight shapes to pick from,
// with whether they get a tinted inside.
// Every icon is drawn from the same geometry the drawing uses
// (@onden/markdown inkShapes), so what the icon shows is what comes out.

/** English source names, translated where shown. */
const SHAPE_LABELS: Record<string, string> = {
  line: "Straight line",
  arrow: "Arrow",
  rectangle: "Rectangle",
  roundedRectangle: "Rounded rectangle",
  ellipse: "Ellipse",
  circle: "Ellipse",
  triangle: "Triangle",
  diamond: "Diamond",
  star: "Star",
};

/** The corners the icon draws a kind between, inside its 24 × 24 box. */
const ICON_BOX: Record<string, [[number, number], [number, number]]> = {
  line: [[4, 20], [20, 4]],
  arrow: [[4, 20], [20, 4]],
  ellipse: [[3, 6], [21, 18]],
  circle: [[3, 6], [21, 18]],
};
const DEFAULT_BOX: [[number, number], [number, number]] = [[4, 4], [20, 20]];

export function InkShapeIcon({ kind, size = 16, fill = "none" }: { kind: InkShapeKind; size?: number; fill?: InkShapeFill }) {
  const [start, end] = ICON_BOX[kind] ?? DEFAULT_BOX;
  // A stronger tint than the drawing's, so it still reads at icon size.
  const tint = inkShapeIsFilled({ kind, fill }) ? { fill: "currentColor", fillOpacity: INK_SHAPE_FILL_ALPHA * 2 } : { fill: "none" };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...tint} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={inkShapePathD({ kind, start, end, size: 2 })} />
    </svg>
  );
}

export function useShapeLabel(): (kind: InkShapeKind) => string {
  const t = useT();
  return (kind) => t(SHAPE_LABELS[kind] ?? "Shape");
}

/** The shape button of the ink toolbar. Pressing it chooses the shape tool and
 *  opens the list; pressing it again (while the tool is on) shows or hides the list. */
export default function InkShapeButton({
  kind, fill, active, onKindChange, onFillChange, onActivate,
}: {
  kind: InkShapeKind;
  fill: InkShapeFill;
  active: boolean;
  onKindChange: (kind: InkShapeKind) => void;
  onFillChange: (fill: InkShapeFill) => void;
  /** Make the shape tool the current tool. */
  onActivate: () => void;
}) {
  const t = useT();
  const label = useShapeLabel();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLElement>({ open, onClose: () => setOpen(false) });
  const name = `${t("Shape")} — ${label(kind)}`;
  return (
    <>
      <Pressable
        ref={pop.anchor as React.RefObject<HTMLButtonElement>}
        type="button"
        className={active ? "ink-tool-btn ink-shape-btn active" : "ink-tool-btn ink-shape-btn"}
        onClick={() => {
          if (!active) onActivate();
          setOpen(!active || !open);
        }}
        aria-pressed={active}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={name}
        title={name}
        data-ink-tool="shape"
        data-ink-shape-kind={kind}
      ><InkShapeIcon kind={kind} size={15} fill={fill} /></Pressable>
      {open && (
        <Popover popover={pop} label={t("Shape")} className="ink-shape-panel" role="group">
          {INK_SHAPE_KINDS.map((k) => (
            <Pressable
              key={k}
              type="button"
              className={kind === k ? "ink-tool-btn active" : "ink-tool-btn"}
              onClick={() => { onKindChange(k); onActivate(); setOpen(false); }}
              aria-pressed={kind === k}
              aria-label={label(k)}
              title={label(k)}
              data-ink-shape={k}
            ><InkShapeIcon kind={k} size={18} fill={fill} /></Pressable>
          ))}
          <div className="ink-shape-fill" role="group" aria-label={t("Shape fill")}>
            {(["none", "solid"] as const).map((value) => (
              <Pressable
                key={value}
                type="button"
                className={fill === value ? "ink-shape-fill-btn active" : "ink-shape-fill-btn"}
                onClick={() => onFillChange(value)}
                aria-pressed={fill === value}
                data-ink-shape-fill={value}
              ><InkShapeIcon kind="rectangle" size={16} fill={value} />{value === "none" ? t("No fill") : t("Filled")}</Pressable>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
