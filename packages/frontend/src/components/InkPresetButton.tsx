import { INK_PRESET_NAME_MAX } from "@onden/markdown";
import { Bookmark, Check, Ellipsis, Highlighter, Pen, Plus, Trash2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { MAX_PRESETS, presetMatches, type InkPreset } from "../lib/ink";
import { useInkPresets } from "../hooks/useInkPresets";
import { isEscapeKey, onEnter } from "../lib/keys";
import { useT } from "../lib/i18n";
import { useLongPress } from "../hooks/useLongPress";
import { Popover, Pressable, TextField, usePopover } from "./ui";
import EmptyState from "./EmptyState";

// The pen presets button: a tool, a colour and a thickness saved together, so
// one tap brings the whole pen back. The list holds at most MAX_PRESETS; a row
// is applied by a tap, and renamed or deleted from its ⋯ button or a long press.
// The presets follow the account (lib/inkPrefs inkPresets).

/** The thickness names, as the toolbar's size buttons say them. */
const SIZE_NAMES: Record<InkPreset["sizeId"], string> = { fine: "Fine", medium: "Medium", broad: "Broad" };
const TOOL_NAMES: Record<InkPreset["tool"], string> = { pen: "Pen", highlighter: "Highlighter" };

type CurrentPen = { tool: string; color: string; sizeId: string };

export default function InkPresetButton({ pen, onApply }: {
  /** What the pen is now: it is what 「把目前的存成預設」 saves, and which row is current. */
  pen: CurrentPen;
  /** Bring this preset's tool, colour and thickness back. */
  onApply: (preset: InkPreset) => void;
}) {
  const t = useT();
  const { presets, add, rename, remove, full } = useInkPresets();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => { setOpen(false); setEditing(null); };
  const pop = usePopover<HTMLElement>({ open, onClose: close });
  const label = t("Pen presets");
  // Eraser, Hand and Shape have no colour and thickness of their own: the preset
  // saved then is the pen the person would go back to.
  const savedTool: InkPreset["tool"] = pen.tool === "highlighter" ? "highlighter" : "pen";
  const saveCurrent = () => {
    const sizeId = pen.sizeId in SIZE_NAMES ? (pen.sizeId as InkPreset["sizeId"]) : "medium";
    add({ name: "", tool: savedTool, color: pen.color, sizeId });
  };
  return (
    <>
      <Pressable
        ref={pop.anchor as React.RefObject<HTMLButtonElement>}
        type="button"
        className={open ? "ink-tool-btn active" : "ink-tool-btn"}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-ink-presets=""
      ><Bookmark size={15} /></Pressable>
      {open && (
        <Popover popover={pop} label={label} className="ink-preset-panel">
          {presets.length === 0 && <EmptyState size="inline" title={t("No presets yet. Set up a pen, then save it here.")} />}
          <ul className="ink-preset-list">
            {presets.map((preset) => (
              <PresetRow
                key={preset.id}
                preset={preset}
                current={presetMatches(preset, pen)}
                editing={editing === preset.id}
                onEdit={(on) => setEditing(on ? preset.id : null)}
                onApply={() => { onApply(preset); close(); }}
                onRename={(name) => rename(preset.id, name)}
                onRemove={() => { remove(preset.id); setEditing(null); }}
              />
            ))}
          </ul>
          <Pressable
            type="button"
            className="ink-preset-save"
            onClick={saveCurrent}
            disabled={full}
            data-ink-preset-save=""
          ><Plus size={15} />{full ? t("Up to {n} presets", { n: MAX_PRESETS }) : t("Save the current pen as a preset")}</Pressable>
        </Popover>
      )}
    </>
  );
}

function PresetRow({ preset, current, editing, onEdit, onApply, onRename, onRemove }: {
  preset: InkPreset; current: boolean; editing: boolean;
  onEdit: (on: boolean) => void; onApply: () => void; onRename: (name: string) => void; onRemove: () => void;
}) {
  const t = useT();
  const press = useLongPress(() => onEdit(true));
  const shown = preset.name !== "" ? preset.name : `${t(TOOL_NAMES[preset.tool])} · ${t(SIZE_NAMES[preset.sizeId])}`;
  const ToolIcon = preset.tool === "highlighter" ? Highlighter : Pen;
  if (editing) {
    return (
      <li className="ink-preset-row ink-preset-row--editing" data-ink-preset={preset.id}>
        <span className="ink-preset-swatch" style={{ "--ink-swatch-color": preset.color } as CSSProperties} />
        <TextField
          type="text"
          className="ink-preset-name"
          defaultValue={preset.name}
          placeholder={shown}
          maxLength={INK_PRESET_NAME_MAX}
          autoFocus
          aria-label={t("Preset name")}
          onBlur={(e) => onRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter and Esc here belong to this field (and not to a candidate list): they end the edit, not the panel.
            if (isEscapeKey(e)) { e.stopPropagation(); onEdit(false); return; }
            onEnter(() => { e.stopPropagation(); onRename(e.currentTarget.value); onEdit(false); })(e);
          }}
        />
        <Pressable type="button" className="ink-tool-btn" onClick={onRemove} aria-label={t("Delete preset")} title={t("Delete preset")}><Trash2 size={15} /></Pressable>
        <Pressable type="button" className="ink-tool-btn" onClick={() => onEdit(false)} aria-label={t("Done")} title={t("Done")}><Check size={15} /></Pressable>
      </li>
    );
  }
  return (
    <li className="ink-preset-row" data-ink-preset={preset.id}>
      <Pressable
        type="button"
        className={current ? "ink-preset-use active" : "ink-preset-use"}
        onClick={onApply}
        aria-pressed={current}
        title={t("Tap to use; hold to rename or delete")}
        {...press}
      >
        <span className="ink-preset-swatch" style={{ "--ink-swatch-color": preset.color } as CSSProperties} />
        <span className="ink-preset-label">{shown}</span>
        <ToolIcon size={14} aria-hidden="true" />
        <span className={`ink-size-dot ink-size-dot--${preset.sizeId}`} aria-hidden="true" />
      </Pressable>
      <Pressable type="button" className="ink-tool-btn" onClick={() => onEdit(true)} aria-label={t("Rename or delete preset")} title={t("Rename or delete preset")}><Ellipsis size={15} /></Pressable>
    </li>
  );
}
