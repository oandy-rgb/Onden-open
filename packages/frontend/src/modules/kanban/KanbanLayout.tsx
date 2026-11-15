// M3.4 — Kanban layout renderer.
//
// Groups the executed query rows into vertical columns by a single
// "group field". The group field is the view's `group_by` when set,
// otherwise the first non-built-in visible field (the typical
// single-select / status attribute). Rows whose group value is empty
// land in a trailing "No value" column so nothing is dropped silently.
// Bucketing and column order come from the shared ../groupRows, so a board
// shows the same groups in the same order as the Table / List sections.
//
// Drag-and-drop (M3.4 follow-up — polish-new-views-mount): a card can be
// dragged between columns. The drop column's value IS the new value of the
// grouping field, so the move persists with ONE attribute write through the
// same spine-gated endpoint the table cell editor uses
// (PUT /api/nodes/:id/attributes/:key); the parent then re-runs the query so
// the board re-reads from the substrate.
//
// Pattern borrowed from dnd-kit (MIT; /tmp/featlibs/INDEX.md → kanban): the
// drop target's column id == the new single-select value, persisted with one
// attribute-set. We implement the *pattern* with native HTML5 drag (no new
// dependency — the workspace ships only the experimental @dnd-kit/* packages,
// not the classic React bindings) which is enough for column-to-column moves.
//
// Accessibility (kanban-cards-mouse-only-a11y): native HTML5 drag is mouse-only
// — no keyboard or screen-reader path. dnd-kit's answer is a KeyboardSensor, but
// without the classic React bindings the minimal, dependency-free equivalent is
// a per-card "Move to column" <select> (keyboard- and SR-accessible by default)
// whose option value == the column key. Choosing an option commits the SAME
// attribute-set as a drop (moveCard), so the keyboard path and the drag path are
// one mutation through the same spine-gated endpoint.

import { Pressable } from "../../components/ui";
import { useState } from "react";
import { propertyWriter, writeErrors } from "../../lib/data";
import type { ExecResponse } from "../../lib/viewExec";
import { fieldDisplayName } from "../../components/viewLayoutKit";
import { BUILT_IN_FIELDS, fieldValues, groupLabel, groupRows, movedValue, type RowGroup } from "../../components/viewLayoutKit";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../../components/EmptyState";
import { Select } from "../../components/ui";
import type { ExecRow } from "@onden/contract";

type Props = {
  exec: ExecResponse;
  onSelectNode?: (id: string) => void;
  /** Re-run the view query after a successful card move. */
  onMutated?: () => void;
};

/** Pick the field rows are grouped by: explicit group_by, else first
 *  non-built-in visible field, else null (no groupable field). */
export function pickGroupField(view: ExecResponse["view"]): string | null {
  if (view.group_by) return view.group_by;
  const candidate = view.visible_fields.find((f) => !BUILT_IN_FIELDS.has(f));
  return candidate ?? null;
}

export default function KanbanLayout({ exec, onSelectNode, onMutated }: Props) {
  const t = useT();
  const groupField = pickGroupField(exec.view);
  const [dragId, setDragId] = useState<string | null>(null);
  // The column the drag started in: a card holding a list value sits in one
  // column per element, so a move needs to know which one it leaves (D117).
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!groupField) {
    return (
      <EmptyState size="inline" title={t("Kanban needs a field to group by. Add a single-select / status field to this view (or set its group by) to see columns.")} />
    );
  }

  if (exec.rows.length === 0) {
    return <EmptyState size="inline" title={t("No rows match the current filters.")} />;
  }

  // Columns are the same groups, in the same order, as the Table / List
  // sections (one groupRows). The declared options belong to group_by, so a
  // fallback grouping field has no declared order and stays first-seen.
  const groupOptions =
    groupField === exec.view.group_by ? exec.view.group_field_options ?? null : null;
  const columns = groupRows(exec.rows, groupField, groupOptions);
  const colLabel = (c: RowGroup<ExecRow>) => groupLabel(c, t);

  // Secondary fields shown as small badges on each card (excludes the
  // title and the grouping field — those are already represented).
  const badgeFields = exec.view.visible_fields.filter(
    (f) => f !== "title" && f !== groupField,
  );

  // Persist a card move: set the grouping field to the drop column's value.
  // The "No value" column clears the field (delete-shaped write of "").
  // A list value keeps its other elements (movedValue).
  const moveCard = async (rowId: string, fromKey: string | null, targetKey: string) => {
    const row = exec.rows.find((r) => r.id === rowId);
    if (!row) return;
    const target = columns.find((c) => c.key === targetKey);
    if (!target) return;
    if (fromKey === targetKey) return; // already in this column — no-op
    const nextValue = movedValue(row.attributes[groupField], columns.find((c) => c.key === fromKey)?.value ?? null, target.value);
    setMoving(true);
    setError(null);
    try {
      await propertyWriter.set(rowId, groupField, nextValue);      onMutated?.();
    } catch (err) {
      setError(writeErrors.message(err));
    } finally {
      setMoving(false);
    }
  };

  const onDrop = (targetKey: string) => {
    const id = dragId;
    const from = dragFrom;
    setDragId(null);
    setDragFrom(null);
    setOverKey(null);
    if (id) void moveCard(id, from, targetKey);
  };

  return (
    <>
      {error && <p className="cv-error">{error}</p>}
      <div className="cv-kanban" role="list" aria-label={t("Kanban grouped by {field}", { field: fieldDisplayName(groupField, t) })}>
        {columns.map((col) => (
          <section
            key={col.key}
            className={`cv-kanban-col${overKey === col.key ? " cv-kanban-col--over" : ""}`}
            role="listitem"
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault(); // allow drop
              if (overKey !== col.key) setOverKey(col.key);
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the column box, not its children.
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOverKey((k) => (k === col.key ? null : k));
              }
            }}
            onDrop={(e) => { e.preventDefault(); onDrop(col.key); }}
          >
            <header className="cv-kanban-col-head">
              <span className="cv-kanban-col-title" title={`${groupField}: ${colLabel(col)}`}>
                {colLabel(col)}
              </span>
              <span className="cv-kanban-col-count">{col.rows.length}</span>
            </header>
            <div className="cv-kanban-cards">
              {col.rows.map((row) => (
                <article
                  key={row.id}
                  className={`cv-kanban-card${dragId === row.id ? " cv-kanban-card--dragging" : ""}`}
                  draggable={!moving}
                  aria-grabbed={dragId === row.id}
                  onDragStart={(e) => {
                    setDragId(row.id);
                    setDragFrom(col.key);
                    e.dataTransfer.effectAllowed = "move";
                    // Some browsers require data to start a drag.
                    e.dataTransfer.setData("text/plain", row.id);
                  }}
                  onDragEnd={() => { setDragId(null); setDragFrom(null); setOverKey(null); }}
                >
                  <Pressable
                    className="cv-kanban-card-title"
                    onClick={() => onSelectNode?.(row.id)}
                    disabled={!onSelectNode}
                    title={t("Open this note")}
                  >
                    {displayTitle(row.title)}
                  </Pressable>
                  {badgeFields.length > 0 && (
                    <div className="cv-kanban-card-badges">
                      {badgeFields.map((f) => {
                        const v = fieldValues(row, f).join(", ");
                        if (!v) return null;
                        const display = f === "updated_at"
                          ? dateLabel(v, "numeric")
                          : v;
                        return (
                          <span key={f} className="cv-kanban-badge" title={fieldDisplayName(f, t)}>
                            <span className="cv-kanban-badge-key">{fieldDisplayName(f, t)}</span>
                            <span className="cv-kanban-badge-val">{display}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Keyboard / screen-reader move path: same mutation as a drop. */}
                  <label className="cv-kanban-move">
                    <span className="cv-kanban-move-label">
                      {t("Move {title} to column", { title: row.title || t("card") })}
                    </span>
                    <Select
                      className="cv-kanban-move-select"
                      value={col.key}
                      disabled={moving}
                      onChange={(e) => { void moveCard(row.id, col.key, e.target.value); }}
                    >
                      {columns.map((c) => (
                        <option key={c.key} value={c.key}>{colLabel(c)}</option>
                      ))}
                    </Select>
                  </label>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
