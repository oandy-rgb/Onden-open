import { Pipette } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clamp01, hexToHsv, hsvToHex, normalizeHex, type Hsv } from "../lib/ink";
import { isImeComposing, onEnter } from "../lib/keys";
import { useT } from "../lib/i18n";
import { classNames } from "../lib/utils";
import { capturePointer } from "../lib/pointerDrag";
import { Pressable, TextField } from "./ui";

// The colour picker of the full colour panel: a square for saturation (across)
// and brightness (up), a bar for the hue, and the colour code below for an
// exact value. Dragging either changes the pen colour as the pen moves (`onLive`);
// lifting it keeps the colour among 「我的顏色」 (`onKeep`). Both take a pen, a
// finger or a mouse, and the arrow keys nudge them (Shift: ten times as far).
// It draws nothing the browser's own colour dialog would: that window is tiny
// on Android and different in every browser.

const SV_STEP = 0.01;
const HUE_STEP = 1;

/** The hue / saturation / brightness the person is working with. The same
 *  colour keeps its hue while the square is dragged to grey or black (a hex
 *  value alone forgets it), and follows the pen colour when that changes
 *  from elsewhere (a swatch, the eyedropper, a typed code). */
function useHsv(color: string): { hsv: Hsv; latest: () => Hsv; set: (next: Hsv) => void } {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color) ?? { h: 0, s: 0, v: 0 });
  const live = useRef(hsv);
  useEffect(() => {
    if (hsvToHex(live.current) === color.toLowerCase()) return;
    const next = hexToHsv(color);
    if (next) { live.current = next; setHsv(next); }
  }, [color]);
  return { hsv, latest: () => live.current, set: (next) => { live.current = next; setHsv(next); } };
}

export default function InkColorPicker({ color, onLive, onKeep, onEyedropper }: {
  color: string;
  /** The colour changed (while dragging, typing or nudging). */
  onLive: (color: string) => void;
  /** The person let go of it: keep it among their own colours. */
  onKeep: (color: string) => void;
  /** Start picking a colour from the page; without it there is no eyedropper. */
  onEyedropper?: () => void;
}) {
  const t = useT();
  const { hsv, latest, set } = useHsv(color);
  const [draft, setDraft] = useState<string | null>(null);
  // Each change builds on the latest value, not on the last render: a drag can
  // report several moves between two renders.
  const change = (patch: Partial<Hsv>) => { const next = { ...latest(), ...patch }; set(next); onLive(hsvToHex(next)); };
  const keep = () => onKeep(hsvToHex(latest()));

  const square = useDrag((fx, fy) => change({ s: clamp01(fx), v: clamp01(1 - fy) }), keep);
  const hueBar = useDrag((fx) => change({ h: clamp01(fx) * 360 }), keep);

  const onSquareKey = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;
    const step = (e.shiftKey ? 10 : 1) * SV_STEP;
    const now = latest();
    const next = e.key === "ArrowLeft" ? { s: clamp01(now.s - step) }
      : e.key === "ArrowRight" ? { s: clamp01(now.s + step) }
      : e.key === "ArrowUp" ? { v: clamp01(now.v + step) }
      : e.key === "ArrowDown" ? { v: clamp01(now.v - step) }
      : null;
    if (!next) return;
    e.preventDefault();
    e.stopPropagation(); // the panel's own arrows move focus between buttons
    change(next);
  };
  const onHueKey = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;
    const step = (e.shiftKey ? 15 : 1) * HUE_STEP;
    const dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    change({ h: Math.min(360, Math.max(0, latest().h + dir * step)) });
  };
  const keyUp = (e: KeyboardEvent) => { if (e.key.startsWith("Arrow")) keep(); };

  const hue = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const typed = draft === null ? null : normalizeHex(draft);
  const finishCode = () => { if (typed) onKeep(typed); setDraft(null); };
  return (
    <div className="ink-picker" data-ink-picker="">
      <div
        {...square.handlers}
        className="ink-picker-square"
        style={{ "--ink-picker-hue": hue } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label={t("Saturation and brightness")}
        aria-valuetext={t("Saturation {s}%, brightness {v}%", { s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) })}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        data-ink-picker-square=""
        onKeyDown={onSquareKey}
        onKeyUp={keyUp}
      >
        <span className="ink-picker-thumb" style={{ "--pk-x": `${hsv.s * 100}%`, "--pk-y": `${(1 - hsv.v) * 100}%`, "--ink-swatch-color": hsvToHex(hsv) } as CSSProperties} />
      </div>
      <div
        {...hueBar.handlers}
        className="ink-picker-hue"
        role="slider"
        tabIndex={0}
        aria-label={t("Hue")}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuemin={0}
        aria-valuemax={360}
        data-ink-picker-hue=""
        onKeyDown={onHueKey}
        onKeyUp={keyUp}
      >
        <span className="ink-picker-hue-track" />
        <span className="ink-picker-thumb ink-picker-thumb--bar" style={{ "--pk-x": `${(hsv.h / 360) * 100}%`, "--ink-swatch-color": hue } as CSSProperties} />
      </div>
      <div className="ink-picker-row">
        <span className="ink-picker-preview" style={{ "--ink-swatch-color": color } as CSSProperties} />
        <TextField
          type="text"
          className={classNames("ink-color-code")}
          value={draft ?? color}
          maxLength={7}
          spellCheck={false}
          autoCapitalize="off"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setDraft(e.target.value);
            const ok = normalizeHex(e.target.value);
            if (ok) onLive(ok);
          }}
          onBlur={finishCode}
          onKeyDown={onEnter(finishCode)}
          aria-label={t("Color code")}
          aria-invalid={draft !== null && draft.trim() !== "" && !typed}
          data-ink-color-code=""
        />
        {onEyedropper && (
          <Pressable
            type="button"
            className="ink-tool-btn ink-eyedropper"
            onClick={onEyedropper}
            aria-label={t("Pick a color from the page")}
            title={t("Pick a color from the page")}
            data-ink-eyedropper=""
          ><Pipette size={16} /></Pressable>
        )}
      </div>
    </div>
  );
}

/** Pointer dragging over an element: `move` gets the pointer's place as a
 *  fraction of the element (0–1 across and down, clamped by the caller),
 *  `end` runs when it lets go. Pen, finger and mouse alike; the element keeps
 *  the pointer while it is down, so a drag may leave it. */
function useDrag(move: (fx: number, fy: number) => void, end: () => void) {
  const down = useRef(false);
  const place = (e: ReactPointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) move((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };
  return {
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.button > 0) return;
        down.current = true;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        capturePointer(e.currentTarget, e.pointerId);
        place(e);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (down.current) place(e); },
      onPointerUp: () => { if (down.current) { down.current = false; end(); } },
      onPointerCancel: () => { if (down.current) { down.current = false; end(); } },
    },
  };
}
