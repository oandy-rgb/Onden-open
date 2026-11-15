import type { CSSProperties } from "react";
import type { LinkChip } from "../lib/editorLinkFollow";
import { useT } from "../lib/i18n";
import "./EditorLinkChip.css";
import { Pressable, keepFocus } from "./ui";

type Props = {
  chip: LinkChip;
  /** The editor's wrapper: the chip is placed in its coordinates. */
  wrap: HTMLElement | null;
  onFollow: () => void;
};

// Drawn 32px tall; its 44px touch area is an invisible ::after (EditorLinkChip.css).
const CHIP_WIDTH = 80, CHIP_HEIGHT = 32, GAP = 6, EDGE = 8;
/** Viewport rows kept clear above the chip: the phone's fixed top bar. */
const TOP_CLEAR = 48;

/** The "Open ↗" chip beside the caret while it is inside a link (touch, keyboard
 *  open). Above the caret's line so the text being typed stays visible; below
 *  it only where there is no room above — in the viewport, under the fixed top
 *  bar; the chip may overhang the editor's own top. Pointer-down does not take focus, so
 *  the keyboard stays up. */
export default function EditorLinkChip({ chip, wrap, onFollow }: Props) {
  const t = useT();
  const box = wrap?.getBoundingClientRect();
  const roomAbove = chip.caret.top - CHIP_HEIGHT - GAP >= TOP_CLEAR;
  const top = roomAbove
    ? chip.caret.top - (box?.top ?? 0) - CHIP_HEIGHT - GAP
    : chip.caret.bottom - (box?.top ?? 0) + GAP;
  const left = Math.max(EDGE, Math.min(chip.caret.left - (box?.left ?? 0), (box?.width ?? 320) - CHIP_WIDTH - EDGE));
  return (
    <Pressable
      type="button"
      className="md-link-chip"
      style={{ "--chip-top": `${top}px`, "--chip-left": `${left}px` } as CSSProperties}
      onMouseDown={keepFocus}
      onClick={onFollow}
      aria-label={t("Open link")}
    >
      {t("Open ↗")}
    </Pressable>
  );
}
