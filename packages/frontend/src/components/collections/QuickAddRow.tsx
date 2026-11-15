// In-view quick-add row for collection table/list layouts.
//
// Previously a collection (a #class_tag) could only gain members via the
// API or by tagging an existing note. This row brings the QuickCapture
// pattern (type → Enter → mint a real node) inline at the bottom of the
// view, so a collection feels like a living list you can append to in place.
//
// The flow mirrors what an agent's createNode + applyTag would do:
//   1. POST /api/nodes          → mint a real content node (title only)
//   2. PUT  /api/nodes/:id/tags/:tagId → apply the collection's class tag
//      (this is the SAME spine-gated endpoint as the agent applyTag tool;
//       it seeds field defaults + template expansion)
//   3. onCreated()              → caller re-runs the view query so the new
//      row appears with whatever attributes the tag seeded.
//
// On a note's views (rows = its children) the new note is made a sub-note
// of that note instead of being tagged.
//
// Minimal on purpose: title-only. Per-field editing stays in the inspector
// — this is the capture on-ramp, not a spreadsheet cell editor.

import { randomUUID } from "../../lib/uuid";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { writersFor, writeErrors } from "../../lib/data";
import type { ViewSource } from "./CollectionView";
import { useT } from "../../lib/i18n";
import { isEnterKey } from "../../lib/keys";
import { Pressable, TextField } from "../ui";
import { useHasKeyboard } from "../../hooks/useKbdHint";

type Props = {
  /** A tag's views: its tag is applied to every note minted here. A note's
   *  views: every note minted here is its sub-note. */
  source: ViewSource;
  /** Re-run the view query so the freshly tagged node shows up. */
  onCreated: () => void | Promise<void>;
};

// The form shows its own failure line, so its writer does not toast as well.
const rowWriter = writersFor({ notify: () => {} }).note;

export default function QuickAddRow({ source, onCreated }: Props) {
  const hasKeyboard = useHasKeyboard();
  const t = useT();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const attemptRef = useRef<{ key: string; id: string } | null>(null);
  // A note's sub-notes end in one slim 「＋ 新增子筆記」 row; it becomes the
  // input when pressed. (A tag's view keeps the always-open input.)
  const slim = source.kind === "node";
  const [open, setOpen] = useState(!slim);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    // The row is created WITH the collection's class tag in one request (field
    // defaults and the template run as for any apply): it can never
    // exist untagged (GAP-125). The same title keeps the same id across a
    // retry, so a lost response cannot make a second row.
    const key = `${source.id}\u0000${trimmed}`;
    if (attemptRef.current?.key !== key) attemptRef.current = { key, id: randomUUID() };
    try {
      await rowWriter.create(source.kind === "tag"
        ? { id: attemptRef.current.id, title: trimmed, markdown: "", tagIds: [source.id] }
        : { id: attemptRef.current.id, title: trimmed, markdown: "", parent_id: source.id });
      attemptRef.current = null;
      setTitle("");
      await onCreated();
      inputRef.current?.focus();
    } catch (err) {
      setError(writeErrors.message(err));
    } finally {
      setBusy(false);
    }
  }, [title, busy, source.id, source.kind, onCreated]);

  if (!open) {
    return (
      <div className="cv-quickadd cv-quickadd--slim">
        <Pressable type="button" className="cv-quickadd-open" onClick={() => setOpen(true)}>
          <Plus size={13} aria-hidden="true" /> {t("New sub-note")}
        </Pressable>
      </div>
    );
  }
  return (
    <div className={slim ? "cv-quickadd cv-quickadd--slim" : "cv-quickadd"}>
      <div className="cv-quickadd-input-wrap">
        <Plus size={13} className="cv-quickadd-icon" aria-hidden />
        <TextField
          ref={inputRef}
          className="cv-quickadd-input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterKey(e)) { e.preventDefault(); void submit(); }
          }}
          placeholder={source.kind === "tag" ? t("Add to #{name}…", { name: source.name }) : t("Add a sub-note to {name}…", { name: source.name })}
          aria-label={source.kind === "tag" ? t("Add a new note to #{name}", { name: source.name }) : t("Add a new sub-note to {name}", { name: source.name })}
          disabled={busy}
          autoFocus={slim}
          onBlur={() => { if (slim && !title.trim() && !busy && !error) setOpen(false); }}
        />
        {hasKeyboard && <span className="cv-quickadd-hint"><kbd>↵</kbd></span>}
      </div>
      {error && <p className="cv-quickadd-error">{error}</p>}
    </div>
  );
}
