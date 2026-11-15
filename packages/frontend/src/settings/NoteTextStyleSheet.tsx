import { Minus, Plus } from "lucide-react";
import { Button, Popover, Sheet, Switch, usePopover } from "../components/ui";
import { useIsMobile } from "../hooks/useIsMobile";
import { useT } from "../lib/i18n";
import { openSettings } from "../lib/settingsRequest";
import { APPEARANCE_SETTINGS } from "./appearance";
import { useOption } from "./useOption";
import NoteFontCards from "./NoteFontCards";
import type { SettingDef } from "../lib/settingsTypes";
import "./NoteTextStyleSheet.css";

// The note's ⋯ › 文字樣式: the same font, text size and width as Settings › Notes (the same
// preferences and the same cards). On a desktop a popover right below the ⋯ that was pressed (no
// dimming: the note behind changes as they choose; it stays open until Esc or a press outside, and
// focus goes back to the ⋯); on a phone a bottom sheet. One body for both. 「更多設定」 opens that settings page.

const enumDef = (id: string) => {
  const def = APPEARANCE_SETTINGS.find((s): s is Extract<SettingDef, { type: "enum" }> => s.id === id && s.type === "enum");
  if (!def) throw new Error(`text style: ${id} is not an enum setting`);
  return def;
};
const TEXT_SIZE = enumDef("note.text_size");
const MEASURE = enumDef("note.measure");

/** Where the popover opens when the ⋯ is not known (or no longer on the page): the top-right corner below the bar.
 *  usePopover keeps it inside the window, so an x far to the right lands against the right edge. */
const FALLBACK_POINT = { x: 100_000, y: 56 };

export default function NoteTextStyleSheet({ trigger, onClose }: { trigger: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const [size, setSize] = useOption(TEXT_SIZE);
  const [measure, setMeasure] = useOption(MEASURE);
  const steps = TEXT_SIZE.options.map((o) => o.value);
  const at = Math.max(0, steps.indexOf(size));
  const step = (delta: -1 | 1) => setSize(steps[Math.min(steps.length - 1, Math.max(0, at + delta))]!);
  const phone = useIsMobile();
  const anchored = trigger?.isConnected ? trigger : null;
  const popover = usePopover<HTMLElement>({ open: !phone, onClose, placement: "bottom-end", at: anchored ? undefined : FALLBACK_POINT });
  popover.anchor.current = anchored;
  const body = (
      <div className="note-text-style__body">
        <NoteFontCards />
        <div className="note-text-style__row">
          <Button variant="secondary" aria-label={t("Smaller text")} disabled={at === 0} onClick={() => step(-1)}><Minus size={16} /></Button>
          <span className="note-text-style__size">{t(TEXT_SIZE.options[at]!.label)}</span>
          <Button variant="secondary" aria-label={t("Larger text")} disabled={at === steps.length - 1} onClick={() => step(1)}><Plus size={16} /></Button>
        </div>
        <div className="note-text-style__row">
          <span>{t("Wide page")}</span>
          <Switch on={measure !== "standard" && measure !== "narrow"} label={t("Wide page")} onChange={(on) => setMeasure(on ? "wide" : "standard")} />
        </div>
        <Button variant="ghost" onClick={() => { onClose(); openSettings("notes"); }}>{t("More settings")}</Button>
      </div>
  );
  if (phone) return <Sheet label={t("Text style")} onClose={onClose}>{body}</Sheet>;
  return <Popover popover={popover} label={t("Text style")} className="note-text-style-popover">{body}</Popover>;
}
