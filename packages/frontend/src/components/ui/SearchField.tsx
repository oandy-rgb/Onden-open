import { forwardRef, useCallback, useRef, type InputHTMLAttributes, type KeyboardEvent, type Ref } from "react";
import { Search, X } from "lucide-react";
import { useKbdHint } from "../../hooks/useKbdHint";
import { isEnterKey, isEscapeKey, isImeComposing } from "../../lib/keys";
import { isListNavKey, stepActive } from "../../lib/listNav";
import { useT } from "../../lib/i18n";
import { Button } from "./Button";
import "./SearchField.css";

// The app's one search / filter box. Every place that looks something up (notes, tags, settings, a place to put
// a note, the command palette) uses this, so the magnifier, clear button, height, focus look, phone keyboard
// (type=search, search key) and the IME rules are the same everywhere. The wording is too: the label is
// "Search …" ("搜尋…"), never "Find" / "Filter".
//
//   <SearchField label={t("Search tags…")} value={query} onValueChange={setQuery} />
//
//   // results driven from the box: arrows move, Enter opens, Esc closes — none of it while a Chinese / Japanese
//   // input method is composing (those keys then belong to the candidate list)
//   <SearchField label={t("Search notes…")} shortcut="focus-search" value={q} onValueChange={setQ}
//     nav={{ count: rows.length, active, onActive: setActive, onPick: (i) => open(rows[i]) }} onEscape={close} />
//
// `label` is the aria-label and, unless `placeholder` says otherwise, the placeholder. `shortcut` is a shortcut id
// (lib/shortcuts): useKbdHint gives its keys only on a device with a keyboard, so a phone shows none.
// Other input props (role / aria-* for a combobox, autoFocus, onCompositionStart…) go to the <input>; an
// `onKeyDown` of the caller runs first and `preventDefault()` there skips the built-in keys.

export interface SearchNav {
  count: number;
  active: number;
  onActive: (index: number) => void;
  onPick: (index: number) => void;
  /** Rows the arrows step over (a disabled command). */
  isDisabled?: (index: number) => boolean;
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "size" | "aria-label"> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** "large" for a box that is the point of its dialog (the command palette). */
  size?: "default" | "large";
  shortcut?: string;
  nav?: SearchNav;
  /** Enter with no `nav` (a box that opens its first match). */
  onEnter?: () => void;
  onEscape?: () => void;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label, value, onValueChange, size = "default", shortcut, nav, onEnter, onEscape, placeholder, className, onKeyDown, ...rest }, ref,
) {
  const t = useT();
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback((el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el); else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  }, [ref]);
  const keys = useKbdHint(shortcut ?? "");
  const shown = placeholder ?? label;

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || isImeComposing(e)) return;
    if (isEscapeKey(e)) {
      if (!onEscape) return;
      e.preventDefault(); e.stopPropagation(); onEscape();
    } else if (nav && isListNavKey(e.key)) {
      if (nav.count === 0) return;
      e.preventDefault(); nav.onActive(stepActive(e.key, nav.active, nav.count, nav.isDisabled)!);
    } else if (isEnterKey(e)) {
      if (nav) {
        if (nav.active < 0 || nav.active >= nav.count || nav.isDisabled?.(nav.active)) return;
        e.preventDefault(); nav.onPick(nav.active);
      } else if (onEnter) { e.preventDefault(); onEnter(); }
    }
  };

  return (
    <div className={["ui-search", size === "large" && "ui-search--large", className].filter(Boolean).join(" ")}>
      <Search className="ui-search__icon" size={size === "large" ? 18 : 15} aria-hidden="true" />
      <input
        autoComplete="off" spellCheck={false} enterKeyHint="search"
        {...rest}
        ref={setRef as Ref<HTMLInputElement>}
        className="ui-search__input" type="search" aria-label={label}
        placeholder={shortcut && keys ? `${shown} (${keys})` : shown}
        value={value} onChange={(e) => onValueChange(e.target.value)} onKeyDown={handleKey}
      />
      {value && !rest.readOnly && !rest.disabled && (
        <Button variant="icon" size="sm" className="ui-search__clear" aria-label={t("Clear search")}
          onMouseDown={(e) => e.preventDefault()} // focus stays in the box, so a picker that closes on blur stays open
          onClick={() => { onValueChange(""); own.current?.focus(); }}>
          <X size={14} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
});
