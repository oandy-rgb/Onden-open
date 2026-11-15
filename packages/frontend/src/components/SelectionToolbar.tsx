import { useEffect, useRef, useState } from "react";
import { Link } from "lucide-react";
import { INLINE_WRAPS } from "../lib/editorFormat";
import { useT } from "../lib/i18n";
import { isEnterKey, isEscapeKey } from "../lib/keys";
import ToolbarRow, { type ToolSpecs } from "./ToolbarRow";
import { Popover, Pressable, keepFocus, type PopoverPoint, useInlinePopover, TextField } from "./ui";

// The bubble over a text selection in the editor: formatting, a link, and the
// paragraph tools (加標籤, 交給 AI, 變成子筆記…) the editor hands it as `paragraphTools`
// (components/ParagraphMenu `tools`: the same buttons as the phone bar and the
// handle's menu, their panels drawn by the editor). Which buttons it shows, and
// in what order, is the person's choice (ToolbarRow, Settings › 工具列); this
// says what the formats do and owns the link form. Buttons act on mousedown
// with preventDefault so the selection survives.
//
// On a touch screen the same toolbar renders as the "selection mode" of the
// editor's bottom bar (variant "bar") instead of floating over the text, where
// it would sit on the OS selection handles next to the OS copy/paste menu.
// There buttons are 44px, act on click (a swipe scrolls the row instead), and
// preventDefault pointerdown so the tap never takes focus from the editor.

type Props = {
  /** Where the floating bubble goes; unused by the bar. */
  at?: PopoverPoint;
  /** Esc or a press outside the floating bubble (not the bar). */
  onDismiss?: () => void;
  /** "bubble" floats at `at`; "bar" fills the mobile bottom bar's row. */
  variant?: "bubble" | "bar";
  /** Button labels (Bold, Heading 1, Quote…) whose format the selection has. */
  active?: ReadonlySet<string>;
  /** The link form was dismissed (the bar puts focus back in the editor). */
  onCancel?: () => void;
  onWrap: (before: string, after: string) => void;
  onQuote: () => void;
  onHeading: (level: 1 | 2 | 3) => void;
  onLink: (url: string) => void;
  /** The paragraph tools for this selection (加標籤, 交給 AI, 複製段落連結, 這段的歷史, 變成子筆記…). */
  paragraphTools?: ToolSpecs;
  /** One of their panels is open: a press in it is not a press outside the bubble. */
  panelOpen?: boolean;
  /** A panel or 「更多」 is open: the editor keeps its bar up while focus is in it. */
  onPanelOpenChange?: (open: boolean) => void;
};

const NO_TOOLS: ToolSpecs = {};

/** The inline formats, by tool id. */
const WRAP_TOOLS = [
  { id: "bold", label: "Bold" },
  { id: "italic", label: "Italic" },
  { id: "strike", label: "Strikethrough" },
  { id: "underline", label: "Underline" },
  { id: "highlight", label: "Highlight" },
  { id: "code", label: "Inline code" },
] as const;

export default function SelectionToolbar({
  at, onDismiss, variant = "bubble", active, onCancel, onWrap, onQuote, onHeading, onLink, paragraphTools = NO_TOOLS, panelOpen, onPanelOpenChange,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<"format" | "link">("format");
  const [url, setUrl] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mode === "link") linkInput.current?.focus(); }, [mode]);

  const bar = variant === "bar";
  const iconSize = bar ? 18 : 13;
  // A press in a paragraph panel (its own surface) is not a press outside the bubble.
  const bubblePop = useInlinePopover({ open: !bar && !!at, onClose: () => { if (!panelOpen) onDismiss?.(); }, at });
  const closeForm = () => { setMode("format"); setUrl(""); };
  const cancel = () => { closeForm(); onCancel?.(); };
  const applyLink = () => { onLink(url); closeForm(); };
  const pressed = (label: string) => (bar ? (active?.has(label) ?? false) : undefined);

  const tools: ToolSpecs = {
    ...Object.fromEntries(WRAP_TOOLS.map(({ id, label }) => {
      const wrap = INLINE_WRAPS.find((w) => w.label === label)!;
      return [id, { run: () => onWrap(wrap.before, wrap.after), pressed: pressed(label) }];
    })),
    link: { run: () => { setUrl(""); setMode("link"); } },
    ...paragraphTools,
    quote: { run: onQuote, pressed: pressed("Quote") },
    h1: { run: () => onHeading(1), pressed: pressed("Heading 1") },
    h2: { run: () => onHeading(2), pressed: pressed("Heading 2") },
    h3: { run: () => onHeading(3), pressed: pressed("Heading 3") },
  };

  const row = (
    <div className={bar ? `md-selection-bar${mode === "format" ? " md-selection-bar--tools" : " md-mobile-toolbar-scroll"}` : "tiptap-bubble-row"}
      role={bar ? "group" : undefined} aria-label={bar ? t("Format selection") : undefined}
      onMouseDown={keepFocus}>
      {mode === "link" ? (
        <>
          <TextField ref={linkInput} className="bubble-link-input" placeholder="https://..."
            value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (isEnterKey(e)) { e.preventDefault(); applyLink(); }
              if (isEscapeKey(e)) cancel();
            }} />
          <Pressable type="button" title={t("Apply link")} aria-label={t("Apply link")} className={bar ? "md-mobile-tool" : undefined}
            onClick={applyLink}><Link size={iconSize} /></Pressable>
          <Pressable type="button" title={t("Cancel")} aria-label={t("Cancel")} className={bar ? "md-mobile-tool" : undefined}
            onClick={cancel}>✕</Pressable>
        </>
      ) : (
        <ToolbarRow surface="selection" variant={variant} tools={tools} onMoreOpenChange={onPanelOpenChange} />
      )}
    </div>
  );
  return bar ? row : <Popover popover={bubblePop} label={t("Format selection")} role="toolbar" className="tiptap-bubble-menu">{row}</Popover>;
}
