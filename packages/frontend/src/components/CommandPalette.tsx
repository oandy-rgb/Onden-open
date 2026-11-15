import type { PaletteItem } from "../lib/paletteItem";
import { SnippetText } from "./SnippetText";
import "./CommandPalette.css";
import { useEffect, useRef } from "react";
import { FileText, Hash, LayoutDashboard, Plus, Sparkles, Zap } from "lucide-react";
import { classNames } from "../lib/utils";
import { t } from "../lib/i18n";
import { formatChord, kbdHint, matchShortcut, shortcutById } from "../lib/shortcuts";
import { isImeComposing } from "../lib/keys";
import { matchTitle } from "../lib/noteSearch";
import { PREFS } from "../lib/prefs";
import { useHintOnce } from "../hooks/useHintOnce";
import { Button, CloseButton, FieldError, Modal, Pressable, SearchField } from "./ui";
import { SearchOfflineNotice } from "./SearchOfflineNotice";
import type { NoteSearchOutcome } from "../lib/data";
import EmptyState from "./EmptyState";
import { useHasKeyboard } from "../hooks/useKbdHint";

// The node_type badge is a raw slug (e.g. "content", "task", "daily").
// Render a short, human label so every Recent row doesn't read an identical
// generic "content". Falls back to the raw value (Title-cased) when unmapped.
const KIND_BADGE: Record<string, string> = {
  content: "Note",
  note: "Note",
  task: "Task",
  daily: "Daily",
  canvas: "Canvas",
  collection: "Collection",
  tag: "Tag",
  class_tag: "Tag",
};
function kindBadge(hint: string): string {
  if (KIND_BADGE[hint]) return t(KIND_BADGE[hint]);
  return hint ? hint.charAt(0).toUpperCase() + hint.slice(1) : hint;
}

// Resolve the kbd chord to display for an action row: prefer an explicit
// shortcutId, else fall back to the action id itself (many action ids already
// match a SHORTCUTS entry). Returns the platform-formatted chord or null.
function actionChord(item: Extract<PaletteItem, { kind: "action" }>): string | null {
  const sc = shortcutById(item.shortcutId ?? item.id);
  return sc ? formatChord(sc.chord) : null;
}



type Props = {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  index: number;
  onIndexChange: (i: number) => void;
  items: PaletteItem[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  searching: boolean;
  busy?: boolean;
  actionFailed?: boolean;
  searchError?: boolean;
  /** Where the shown results came from (offline notice); null while none. */
  searchOutcome?: NoteSearchOutcome | null;
  onRetrySearch?: () => void;
  onSelect: (item: PaletteItem) => void;
};

export default function CommandPalette({
  open, onClose, query, onQueryChange, index, onIndexChange,
  items, inputRef, searching, busy = false, actionFailed = false, searchError = false, searchOutcome = null, onRetrySearch, onSelect,
}: Props) {
  const hasKeyboard = useHasKeyboard();
  // Keep the keyboard-selected row visible as the user arrows past the
  // visible window of .palette-list.
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [index, open, items]);

  // Dismissible prefix-hint footer line — once dismissed, stays hidden (the
  // user has learned the modes). Local habit signal, degrades to shown.
  const { show: showHint, markSeen: dismissHint } = useHintOnce("palette-prefix", PREFS.paletteHintDismissed);

  if (!open) return null;

  // Strip the active prefix so the matched portion highlights against the bare
  // term, not the "#"/">"/"?" sigil.
  const prefix = query.startsWith(">") || query.startsWith("#") || query.startsWith("?") ? query[0] : "";
  const displayQuery = prefix ? query.slice(1).trimStart() : query;

  const grouped = items.reduce<Array<{ group: string; items: Array<{ item: PaletteItem; flatIndex: number }> }>>(
    (acc, item, flatIndex) => {
      const g = item.group ?? "";
      let bucket = acc.find((b) => b.group === g);
      if (!bucket) { bucket = { group: g, items: [] }; acc.push(bucket); }
      bucket.items.push({ item, flatIndex });
      return acc;
    },
    [],
  );

  const itemLabel = (item: PaletteItem) =>
    item.kind === "node" ? item.title : item.label;

  // A disabled action row is non-selectable: arrow navigation steps over it and
  // Enter won't fire it. Mirrors the render-time disabled check.
  const isDisabled = (item: PaletteItem) =>
    item.kind === "action" && item.when ? !item.when() : false;

  const visualOrder = grouped.flatMap(group => group.items);

  const itemIcon = (item: PaletteItem) => {
    if (item.kind === "create") return <Plus size={14} />;
    if (item.kind === "node") return item.hint === "tag" ? <Hash size={14} /> : <FileText size={14} />;
    if (item.kind === "canvas") return <LayoutDashboard size={14} />;
    if (item.hint === "ai") return <Sparkles size={14} />;
    return <Zap size={14} />;
  };

  // ui/Modal owns Esc, focus and the page behind. Its own chord (whatever it
  // is on this device) opens over modals, so the palette answers it here and
  // stops it: one press toggles it closed, not closed-then-reopened.
  return (
    <Modal label={t("Command palette")} className="palette-backdrop" busy={busy} onClose={onClose} initialFocus={inputRef}>
      <div className="palette-modal"
        onKeyDown={e => {
          if (isImeComposing(e) || matchShortcut(e.nativeEvent)?.id !== "open-palette") return;
          e.preventDefault(); e.stopPropagation();
          if (!busy) onClose();
        }}>
        <div className="palette-input-wrap">
          <SearchField
            ref={inputRef}
            size="large"
            label={
              prefix === ">" ? t("Run a command…")
              : prefix === "#" ? t("Jump to a tag…")
              : prefix === "?" ? t("Search note contents…")
              : t("Search notes · # tags · > commands · ? search")
            }
            value={query}
            readOnly={busy}
            onValueChange={onQueryChange}
            // No arrows or Enter while results load or an action runs. Arrows follow the displayed
            // group order, which can differ from the input array.
            nav={searching || busy ? undefined : {
              count: visualOrder.length,
              active: visualOrder.findIndex(row => row.flatIndex === index),
              onActive: (i) => onIndexChange(visualOrder[i]!.flatIndex),
              // Closing restores the opener's focus. Enter is consumed before that happens, or its
              // default button activation reopens us.
              onPick: (i) => onSelect(visualOrder[i]!.item),
              isDisabled: (i) => isDisabled(visualOrder[i]!.item),
            }}
          />
          <CloseButton disabled={busy} onClick={onClose} />
        </div>
        <div className="palette-list" aria-busy={searching || busy}>
          {busy && <EmptyState size="inline" as="div" role="status" title={t("Working…")} />}
          {actionFailed && <FieldError>{t("The action did not finish. Your query is still here.")}</FieldError>}
          {searching && <EmptyState size="inline" as="div" className="palette-searching" title={t("Searching…")} />}
          {searchError && <FieldError className="palette-retry-row">
            <span>{t("Search is unavailable. Your query is still here.")}</span>
            <Button type="button" onClick={onRetrySearch}>{t("Try again")}</Button>
          </FieldError>}
          {!searching && <SearchOfflineNotice outcome={searchOutcome} className="palette-offline-notice" />}
          {!searching && !searchError && items.length === 0 && <EmptyState size="inline" as="div" title={t("No results")} />}
          {!searching && grouped.map(({ group, items: groupItems }) => (
            <div key={group} className="palette-group">
              {group && <div className="palette-group-header">{t(group)}</div>}
              {groupItems.map(({ item, flatIndex }) => {
                // Context-availability: action rows whose when() returns false
                // render disabled (greyed, non-actionable) with a reason tooltip,
                // rather than disappearing — the user still learns the command
                // exists and why it can't run right now.
                const disabled = busy || (item.kind === "action" && item.when ? !item.when() : false);
                const chord = item.kind === "action" ? actionChord(item) : null;
                return (
                <Pressable
                  key={item.id}
                  ref={flatIndex === index ? activeRef : undefined}
                  className={classNames("palette-item", flatIndex === index && "active", disabled && "disabled")}
                  disabled={disabled}
                  aria-disabled={disabled || undefined}
                  title={disabled && item.kind === "action" && item.disabledReason ? t(item.disabledReason) : undefined}
                  onMouseEnter={() => { if (!disabled) onIndexChange(flatIndex); }}
                  onClick={() => { if (!disabled) onSelect(item); }}
                >
                  <span className="palette-item-icon">{itemIcon(item)}</span>
                  <div className="palette-item-content">
                    {/* Note, tag and canvas titles are the user's words; action
                        and "Create note: …" labels are interface text. */}
                    <span className="palette-item-label" data-user-content={item.kind === "node" || item.kind === "canvas" || undefined}>
                      <SnippetText snippet={{ text: itemLabel(item), ranges: matchTitle(displayQuery, itemLabel(item))?.ranges ?? [] }} markClassName="palette-hl" />
                    </span>
                    {item.kind === "node" && item.snippet && (
                      <span className="palette-item-snippet">
                        <SnippetText snippet={item.snippet} markClassName="palette-hl" />
                      </span>
                    )}
                  </div>
                  <div className="palette-item-meta">
                    {chord && <kbd className="palette-kbd">{chord}</kbd>}
                    {item.kind === "node" && <span className="palette-item-hint">{kindBadge(item.hint)}</span>}
                    {item.kind === "canvas" && <span className="palette-item-hint">{t(item.hint === "current" ? "Current canvas" : "Canvas")}</span>}
                  </div>
                </Pressable>
                );
              })}
            </div>
          ))}
        </div>
        {showHint && (
          // A one-line, dismissible prefix-mode legend above the keymap
          // footer, drawn as a footer row. Click anywhere on it to dismiss for good.
          <Pressable
            type="button"
            className="palette-footer palette-hint"
            aria-label={t("Dismiss hint")}
            title={t("Dismiss hint")}
            onClick={dismissHint}
          >
            <span><kbd>#</kbd> {t("Tags")} · <kbd>&gt;</kbd> {t("Commands")} · <kbd>?</kbd> {t("Search")}</span>
            <span className="palette-footer-sep" />
            <span aria-hidden>×</span>
          </Pressable>
        )}
        <div className="palette-footer">
          {hasKeyboard && <>
            <span>↑↓ {t("Navigate")}</span>
            <span>↵ {t("Select")}</span>
            <span>esc {t("Close")}</span>
            <span className="palette-footer-sep" />
            <span><kbd>{kbdHint("open-palette")}</kbd> {t("Toggle palette")}</span>
          </>}
        </div>
      </div>
    </Modal>
  );
}
