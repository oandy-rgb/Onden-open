import { INK_SIZES } from "../lib/inkSizes";
import { Eraser, Hand, Highlighter, Pen, Pipette, Redo2, Ellipsis, Undo2 } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_QUICK_COLORS, type InkActiveTool, type InkPaletteState, type InkPreset, type InkShapeFill, type InkShapeKind } from "../lib/ink";
import { useInkPalette } from "../hooks/useInkPalette";
import { useEyedropper } from "../hooks/useEyedropper";
import { useT } from "../lib/i18n";
import { formatChord } from "../lib/shortcuts";
import InkColorPanel, { ColorSwatch } from "./InkColorPanel";
import InkInsertButton from "./InkInsertButton";
import InkPresetButton from "./InkPresetButton";
import InkShapeButton from "./InkShapePicker";
import { Popover, Pressable, layerClass, surfaceHost, usePopover } from "./ui";
import "./InkToolbar.css";
import { observeSize } from "../lib/observeSize";

// Shared ink toolbar: tool / color / size / history. Extracted from
// InkNodeView so the knowledge-canvas pen mode (CanvasInkLayer) reuses the
// exact same chrome instead of growing a sibling dialect.

// Ink colours are stored as canonical (light-theme) hex values; lib/ink inverts
// lightness at render time in dark mode. The toolbar shows five quick colours
// (the person's own, lib/ink/palette) and a 「更多」 button for the full palette.
// The colours the toolbar started with, before they could be changed:
export const INK_COLORS: Array<{ id: string; value: string }> = [
  { id: "ink", value: DEFAULT_QUICK_COLORS[0]! },
  { id: "oxblood", value: DEFAULT_QUICK_COLORS[1]! },
  { id: "blue", value: DEFAULT_QUICK_COLORS[2]! },
  { id: "amber", value: DEFAULT_QUICK_COLORS[3]! },
  { id: "red", value: DEFAULT_QUICK_COLORS[4]! },
];

/** One of four: three draw, Hand pans (one finger; two fingers always pan
 *  and zoom). */
const TOOLS: Array<InkToolEntry<InkActiveTool>> = [
  { id: "pen", label: "Pen", icon: <Pen size={15} /> },
  { id: "highlighter", label: "Highlighter", icon: <Highlighter size={15} /> },
  { id: "eraser", label: "Eraser", icon: <Eraser size={15} /> },
  { id: "hand", label: "Hand", icon: <Hand size={15} /> },
];

/** A tool the host adds to the shared group (the PDF's Select and shapes).
 *  `label` and `hint` are English source strings, translated here. */
export type InkToolEntry<Id extends string> = {
  id: Id;
  label: string;
  icon: ReactNode;
  /** Longer tooltip after the label, for a tool that needs a sentence. */
  hint?: string;
  /** The attribute that carries `id` for styles and tests (default `data-ink-tool`). */
  dataAttr?: string;
};

type Props<Extra extends string> = {
  tool: InkActiveTool | Extra;
  onToolChange: (tool: InkActiveTool | Extra) => void;
  /** Host tools in the same group, before Pen / after Hand. Notes and the
   *  canvas pass none, so their toolbar is unchanged. */
  leadingTools?: Array<InkToolEntry<Extra>>;
  trailingTools?: Array<InkToolEntry<Extra>>;
  /** Pinned at the far right, after undo / redo (the PDF's "⋯" menu). */
  trailing?: ReactNode;
  /** Look only: just Hand among the built-in tools, no colour, size, stylus
   *  switch or history. The host's own tools and `trailing` stay. */
  readOnly?: boolean;
  /** The pen colour, as the hex value stored on strokes. */
  color: string;
  onColorChange: (color: string) => void;
  sizeId: string;
  onSizeChange: (size: { id: string; value: number }) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The shape tool: one button that shows the last shape used and opens the
   *  list. Hosts whose engine draws shapes pass it; without it there is none. */
  shape?: { kind: InkShapeKind; onKindChange: (kind: InkShapeKind) => void; fill: InkShapeFill; onFillChange: (fill: InkShapeFill) => void };
  /** 「插入」: a picture from the photo library / files or the camera. The host
   *  uploads and places what is chosen; hosts without a place for pictures (the
   *  PDF) pass none and the toolbar has no such button. */
  insert?: { onFiles: (files: File[]) => void; busy?: boolean };
  className?: string;
};

export default function InkToolbar<Extra extends string = never>({
  tool, onToolChange, leadingTools = [], trailingTools = [], trailing, readOnly = false,
  color, onColorChange, sizeId, onSizeChange,
  canUndo, canRedo, onUndo, onRedo, shape, insert, className,
}: Props<Extra>) {
  const t = useT();
  const colors = useInkPalette();
  const hasShape = shape !== undefined && !readOnly;
  const hasInsert = insert !== undefined;
  // A colour from the full palette: use it and remember it among the recent ones.
  const pickFromPalette = (value: string) => { onColorChange(value); colors.noteUsed(value); };
  const pickCustom = (value: string) => { onColorChange(value); colors.addCustom(value); };
  // The eyedropper: the next press on the page takes the colour stored there.
  const [picking, setPicking] = useState(false);
  const { missed } = useEyedropper(picking && !readOnly, pickFromPalette, () => setPicking(false));
  useEffect(() => { setPicking(false); }, [tool]); // another tool is another job
  // A preset brings back its tool, colour and thickness together.
  const applyPreset = (preset: InkPreset) => {
    onToolChange(preset.tool);
    onColorChange(preset.color);
    const size = INK_SIZES.find((s) => s.id === preset.sizeId);
    if (size) onSizeChange(size);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const pop = usePopover<HTMLElement>({ open: compact && panelOpen, onClose: () => setPanelOpen(false) });
  // Width the scrolling part needs with colour and size inline. Only the
  // expanded layout can measure it, so it is kept for deciding when to expand.
  const fullWidth = useRef<number | null>(null);
  const builtIn: Array<InkToolEntry<InkActiveTool>> = readOnly ? TOOLS.filter((entry) => entry.id === "hand") : TOOLS;
  const entries: Array<InkToolEntry<InkActiveTool | Extra>> = [...leadingTools, ...builtIn, ...trailingTools];

  // Collapse colour and size into one button when the tools row would
  // overflow; measured from the real width, not guessed from the device.
  useLayoutEffect(() => { fullWidth.current = null; setCompact(false); }, [entries.length, readOnly, hasShape, hasInsert]);
  useLayoutEffect(() => {
    const scroll = rootRef.current?.querySelector<HTMLElement>(".ink-toolbar-scroll");
    if (!scroll || readOnly) return;
    const measure = () => {
      if (!compact) {
        fullWidth.current = scroll.scrollWidth;
        if (scroll.scrollWidth > scroll.clientWidth) setCompact(true);
      } else if (fullWidth.current !== null && scroll.clientWidth >= fullWidth.current) {
        setCompact(false);
      }
    };
    measure();
    return observeSize(scroll, measure);
  }, [compact, readOnly, entries.length, hasShape, hasInsert]);

  return (
    <div ref={rootRef} className={className ? `ink-note-toolbar ${className}` : "ink-note-toolbar"}>
      <div className="ink-toolbar-scroll">
      <div className="ink-toolbar-group" role="group" aria-label={t("Tool")}>
        {entries.map((entry) => {
          const name = entry.hint ? `${t(entry.label)} — ${t(entry.hint)}` : t(entry.label);
          const shapeButton = hasShape && entry.id === "hand" ? (
            <InkShapeButton
              key="shape"
              kind={shape.kind}
              fill={shape.fill}
              active={tool === "shape"}
              onKindChange={shape.onKindChange}
              onFillChange={shape.onFillChange}
              onActivate={() => onToolChange("shape")}
            />
          ) : null;
          return (
            <Fragment key={entry.id}>
              {shapeButton}
            <Pressable
              key={entry.id}
              type="button"
              className={tool === entry.id ? "ink-tool-btn active" : "ink-tool-btn"}
              onClick={() => onToolChange(entry.id)}
              aria-pressed={tool === entry.id}
              aria-label={name}
              title={name}
              {...{ [entry.dataAttr ?? "data-ink-tool"]: entry.id }}
            >{entry.icon}</Pressable>
            </Fragment>
          );
        })}
      </div>
      {!readOnly && <>
      {insert && (
        <div className="ink-toolbar-group" role="group" aria-label={t("Insert")}>
          <InkInsertButton onFiles={insert.onFiles} busy={insert.busy} />
        </div>
      )}
      {compact ? (
        <div className="ink-toolbar-group">
          <Pressable
            ref={pop.anchor as React.RefObject<HTMLButtonElement>}
            type="button"
            className={panelOpen ? "ink-tool-btn active" : "ink-tool-btn"}
            onClick={() => setPanelOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            aria-label={t("Color and size")}
            title={t("Color and size")}
            data-ink-compact-trigger=""
          >
            <span
              className={`ink-compact-dot ink-compact-dot--${sizeId}`}
              style={{ "--ink-swatch-color": color } as CSSProperties}
            />
          </Pressable>
        </div>
      ) : <>
        <InkColorGroup color={color} palette={colors.palette} onQuick={onColorChange} onPalette={pickFromPalette} onLive={onColorChange} onCustom={pickCustom} onQuickSlot={(slot) => colors.setQuickSlot(slot, color)} onEyedropper={() => setPicking(true)} />
        <InkSizeGroup sizeId={sizeId} onPick={onSizeChange} />
      </>}
      <div className="ink-toolbar-group">
        <InkPresetButton pen={{ tool, color, sizeId }} onApply={applyPreset} />
      </div>
      </>}
      </div>
      {compact && panelOpen && (
        <Popover popover={pop} label={t("Color and size")} className="ink-compact-panel">
          <InkColorGroup inline color={color} palette={colors.palette} onQuick={(c) => { onColorChange(c); setPanelOpen(false); }} onPalette={pickFromPalette} onLive={onColorChange} onCustom={pickCustom} onQuickSlot={(slot) => colors.setQuickSlot(slot, color)} onEyedropper={() => { setPanelOpen(false); setPicking(true); }} />
          <InkSizeGroup sizeId={sizeId} onPick={(z) => { onSizeChange(z); setPanelOpen(false); }} />
        </Popover>
      )}
      {!readOnly && (
      <div className="ink-toolbar-group ink-toolbar-group--history" role="group" aria-label={t("History")}>
        <Pressable
          className="ink-tool-btn"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={t("Undo ({keys})", { keys: formatChord("$mod+z") })} title={t("Undo ({keys})", { keys: formatChord("$mod+z") })}
        ><Undo2 size={15} /></Pressable>
        <Pressable
          className="ink-tool-btn"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label={t("Redo ({keys})", { keys: formatChord("$mod+shift+z") })} title={t("Redo ({keys})", { keys: formatChord("$mod+shift+z") })}
        ><Redo2 size={15} /></Pressable>
      </div>
      )}
      {trailing && <div className="ink-toolbar-group ink-toolbar-group--trailing">{trailing}</div>}
      {picking && !readOnly && createPortal(
        <div className={`${layerClass.fixed} ink-eyedropper-hint`} role="status" data-ink-eyedropper-ui="" data-ink-eyedropper-missed={missed ? "" : undefined}>
          <Pressable
            type="button"
            className="ink-tool-btn active"
            onClick={() => setPicking(false)}
            aria-pressed="true"
            aria-label={t("Pick a color from the page")}
            title={t("Pick a color from the page")}
            data-ink-eyedropper-stop=""
          ><Pipette size={16} /></Pressable>
          <span>{missed ? t("Nothing there. Tap a stroke, shape or text.") : t("Tap a stroke, shape or text to take its color")}</span>
          <Pressable type="button" className="ink-eyedropper-cancel" onClick={() => setPicking(false)}>{t("Cancel")}</Pressable>
        </div>,
        surfaceHost(),
      )}
    </div>
  );
}

/** The five quick colours and 「更多」. In the toolbar 「更多」 opens its own panel; in
 *  the collapsed colour-and-size panel (`inline`) it unfolds the full panel in place. */
function InkColorGroup({
  color, palette, inline = false, onQuick, onPalette, onLive, onCustom, onQuickSlot, onEyedropper,
}: {
  color: string;
  palette: InkPaletteState;
  inline?: boolean;
  onQuick: (color: string) => void;
  onPalette: (color: string) => void;
  onLive: (color: string) => void;
  onCustom: (color: string) => void;
  onQuickSlot: (slot: number) => void;
  onEyedropper: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLElement>({ open: open && !inline, onClose: () => setOpen(false) });
  // The current colour is not one of the five: the button shows it, as the active one.
  const offQuick = !palette.quick.some((c) => c.toLowerCase() === color.toLowerCase());
  // Picking from the page needs the page in view: the panel closes, the hint takes over.
  const panel = <InkColorPanel color={color} palette={palette} onPick={onPalette} onLive={onLive} onCustom={onCustom} onQuickSlot={onQuickSlot} onEyedropper={() => { setOpen(false); onEyedropper(); }} />;
  return (
    <div className="ink-toolbar-group" role="group" aria-label={t("Color")}>
      {palette.quick.map((c) => (
        <ColorSwatch key={c} color={c} active={color.toLowerCase() === c.toLowerCase()} onPick={onQuick} />
      ))}
      <Pressable
        ref={pop.anchor as React.RefObject<HTMLButtonElement>}
        type="button"
        className={offQuick || open ? "ink-tool-btn ink-color-more active" : "ink-tool-btn ink-color-more"}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("More colors")}
        title={t("More colors")}
        data-ink-more-colors=""
      >{offQuick ? <span className="ink-compact-dot ink-compact-dot--medium" style={{ "--ink-swatch-color": color } as CSSProperties} /> : <Ellipsis size={15} />}</Pressable>
      {open && !inline && <Popover popover={pop} label={t("More colors")} className="ink-color-popover">{panel}</Popover>}
      {open && inline && <div className="ink-color-inline">{panel}</div>}
    </div>
  );
}

function InkSizeGroup({ sizeId, onPick }: { sizeId: string; onPick: (size: { id: string; value: number }) => void }) {
  const t = useT();
  return (
    <div className="ink-toolbar-group" role="group" aria-label={t("Size")}>
      {INK_SIZES.map((s) => (
        <Pressable
          key={s.id}
          type="button"
          className={sizeId === s.id ? "ink-size-btn active" : "ink-size-btn"}
          onClick={() => onPick(s)}
          aria-pressed={sizeId === s.id}
          aria-label={t(s.label)}
          title={t(s.label)}
        >
          <span className={`ink-size-dot ink-size-dot--${s.id}`} />
        </Pressable>
      ))}
    </div>
  );
}
