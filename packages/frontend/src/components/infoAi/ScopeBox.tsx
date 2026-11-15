import { useLayoutEffect, useMemo, useRef } from "react";
import { ArrowUp, X } from "lucide-react";
import { useAppSelector, selectSearchableNodes, useTagRows } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { containsTitle } from "../../lib/noteSearch";
import { listsAsNote } from "../../lib/nodeTags";
import { mentionQuery, QUESTION_MAX, withoutMention, SCOPE_MAX, type ScopeChip } from "../../lib/noteChat";
import { isImeComposing } from "../../lib/keys";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Button, Chip, Pressable, TextArea } from "../ui";

// The question box of the AI conversation. The chips above it say what the AI will read: the open note
// (fixed) and each note or tag the person added (removable). Typing `@` offers notes and tags to add (ranked
// by title: lib/noteSearch containsTitle); choosing one makes a chip and removes the `@word`.
// The box is one line when empty, grows to about six lines and then scrolls; send is the arrow inside its
// right edge. Enter sends where there is a keyboard (Shift+Enter: a new line); on a phone Enter is a new
// line, and ⌘/Ctrl+Enter sends. An IME candidate's Enter never sends.

const MAX_COMPOSER_LINES = 6;

type Row = { kind: ScopeChip["kind"]; id: string; title: string };
const ROWS = 6;

export default function ScopeBox({ nodeId, noteTitle, chips, text, disabled, canSend, sending, onText, onAdd, onRemove, onSend }: {
  nodeId: string; noteTitle: string; chips: readonly ScopeChip[]; text: string; disabled: boolean; canSend: boolean; sending: boolean;
  onText: (text: string) => void; onAdd: (chip: ScopeChip) => void; onRemove: (chip: ScopeChip) => void; onSend: () => void;
}) {
  const t = useT();
  const phone = useIsMobile();
  const input = useRef<HTMLTextAreaElement>(null);
  // Grow with the text up to MAX_LINES, then scroll (no resize handle).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight <= 0) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const pad = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + pad, line * MAX_COMPOSER_LINES + el.offsetHeight - el.clientHeight + 2)}px`;
  }, [text]);
  const nodes = useAppSelector(selectSearchableNodes);
  const tags = useTagRows();
  const mention = useMemo(() => mentionQuery(text), [text]);
  const rows = useMemo((): Row[] => {
    if (!mention || chips.length >= SCOPE_MAX) return [];
    // The first ROWS that fit, stopping there: a workspace can hold thousands of notes.
    const out: Row[] = [];
    const offer = (row: Row) => {
      if (chips.some((c) => c.kind === row.kind && c.id === row.id)) return;
      if (!mention.query || containsTitle(mention.query, row.title)) out.push(row);
    };
    for (const n of nodes) {
      if (out.length >= ROWS) return out;
      if (listsAsNote(n) && n.id !== nodeId) offer({ kind: "note", id: n.id, title: displayTitle(n.title) });
    }
    for (const tag of tags ?? []) {
      if (out.length >= ROWS) return out;
      offer({ kind: "tag", id: tag.id, title: tag.name });
    }
    return out;
  }, [mention, nodes, tags, chips, nodeId]);

  const choose = (row: Row) => {
    if (!mention) return;
    onAdd({ kind: row.kind, id: row.id, title: row.title });
    onText(withoutMention(text, mention));
  };

  return (
    <div className="note-ai-box">
      <ul className="note-ai-scope-list" aria-label={t("What the AI will read")}>
        <li><Chip tone="neutral" className="note-ai-scope-item" title={t("This note is always included")}>{displayTitle(noteTitle)}</Chip></li>
        {chips.map((chip) => (
          <li key={`${chip.kind}:${chip.id}`}>
            <Chip tone="info" className="note-ai-scope-item">
              <span>{chip.kind === "tag" ? `#${chip.title}` : chip.title}</span>
              <Pressable className="note-ai-scope-x" aria-label={t("Remove {name} from the AI's reach", { name: chip.title })} onClick={() => onRemove(chip)}>
                <X size={12} aria-hidden="true" />
              </Pressable>
            </Chip>
          </li>
        ))}
      </ul>
      <div className="note-ai-compose">
        <TextArea
          ref={input} className="note-ai-input" rows={1} value={text} maxLength={QUESTION_MAX} disabled={disabled}
          placeholder={t("Ask about this note (@ adds notes)")}
          aria-label={t("Ask the AI")} aria-expanded={rows.length > 0} aria-haspopup="listbox"
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || isImeComposing(event)) return;
            if (rows.length > 0 && !event.shiftKey) { event.preventDefault(); choose(rows[0]!); return; }
            const sends = event.metaKey || event.ctrlKey || (!phone && !event.shiftKey);
            if (!sends) return;
            event.preventDefault();
            if (canSend && !sending) onSend();
          }}
        />
        <Button variant="icon" className="note-ai-send" aria-label={t("Send question")} title={t("Send question")}
          disabled={!canSend} aria-busy={sending || undefined} onClick={onSend}>
          <ArrowUp size={18} aria-hidden="true" />
        </Button>
      </div>
      {rows.length > 0 && (
        <ul className="note-ai-pick" role="listbox" aria-label={t("Notes and tags to add")}>
          {rows.map((row) => (
            <li key={`${row.kind}:${row.id}`} role="option" aria-selected={false}>
              <Pressable className="note-ai-pick-row" onClick={() => choose(row)}>
                <span className="note-ai-pick-kind">{row.kind === "tag" ? t("Tag") : t("Note")}</span>
                <span className="note-ai-pick-title">{row.title}</span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
