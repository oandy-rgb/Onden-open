// M3.3 — Table layout renderer.
//
// One column per visible_field; rows are the executed query result.
// Built-in fields (title, slug, updated_at) come from the row's top-level
// fields; attribute fields come from row.attributes[key].
//
// First column (title) is clickable → opens the node via onSelectNode.
//
// Attribute cells are inline-editable (M3.3 follow-up): click a cell, type,
// commit on Enter/blur. The write goes through the existing attribute
// mutation (PUT /api/nodes/:id/attributes/:key → spine `mutate`), then the
// parent re-runs the view query so the value re-reads from the substrate.
// Built-in fields (title/slug/updated_at/…) stay read-only — they're derived
// or have their own edit surfaces.
//
// M3.4 — when the view declares group_by, rows are bucketed (client-side,
// pure groupRows helper) into labelled sections; each group renders an
// aggregation footer (count, plus sum/avg for numeric columns). Inline edit
// works within every section.

import { Pressable } from "../../components/ui";
import { useEffect, useRef, useState } from "react";
import { useFieldDraft } from "../../hooks/useFieldDraft";
import { BUILT_IN_FIELDS, inferFieldType, storageType } from "@onden/markdown";
import { propertyWriter, writeErrors } from "../../lib/data";
import type { ExecResponse } from "../../lib/viewExec";
import { groupRows, groupLabel, aggregateField, formatFooter } from "../../components/viewLayoutKit";
import { StarRating, parseRating } from "../../components/attributes/StarRating";
import { useRowWindow } from "../../components/viewLayoutKit";
import { t as tr, useT } from "../../lib/i18n";
import { compactWhenLabel, dateLabel } from "../../lib/timeLabels";
import { fieldDisplayName } from "../../components/viewLayoutKit";
import { isEnterKey, isEscapeKey } from "../../lib/keys";
import { tidyNumberInput } from "../../lib/numberInput";
import { isStoredNumber } from "@onden/markdown";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../../components/EmptyState";
import { TextField } from "../../components/ui";
import { pointBelow, requestFieldEditor } from "../../lib/tagFieldRequest";
import type { ExecRow } from "@onden/contract";

type Props = {
  exec: ExecResponse;
  onSelectNode?: (id: string) => void;
  /** Re-run the view query after a successful cell edit. */
  onMutated?: () => void;
  /** The tag whose field columns open that field's settings (the tag page's popover). */
  editFieldsOf?: string;
};

function cellValue(row: ExecRow, field: string): string {
  if (field === "title")      return row.title;
  if (field === "slug")       return row.slug;
  if (field === "updated_at") return compactWhenLabel(row.updated_at);
  // Attribute fields — the attributes map already carries built-in dupes
  // when the user listed them; prefer that.
  const v = row.attributes[field];
  return v ?? "";
}

/** The exact instant behind a relative cell, for its tooltip. */
function cellTitle(row: ExecRow, field: string): string | undefined {
  return field === "updated_at" ? dateLabel(row.updated_at, "dateTime") : undefined;
}

/** Footer cell for a column: row count for the first column; for the rest,
 *  sum + average on numeric columns (`Σ 120 · avg 24`) or a value count on
 *  text columns. Keeps the footer honest — no fake sums on text columns, and
 *  none over a partial load: while more pages wait (`partial`), the count
 *  says how many of the total are loaded and the other columns stay blank
 *  until Load more has brought every row (D66). */
function footerCell(rows: ExecRow[], field: string, isFirst: boolean, fieldType: string | undefined, partial?: PartialLoad): string {
  if (isFirst) {
    if (partial) {
      return partial.total === undefined
        ? tr("{n} rows loaded", { n: rows.length })
        : tr("{n} of {total} rows", { n: rows.length, total: partial.total });
    }
    return rows.length === 1 ? tr("1 row") : tr("{n} rows", { n: rows.length });
  }
  if (partial) return "";
  // A schema field gives the column's storage type; a free-form one has none.
  return formatFooter(aggregateField(rows, field, fieldType === undefined ? undefined : storageType(fieldType)));
}

/** The cell being edited, and its text when the edit began. */
type EditState = { nodeId: string; field: string; original: string };

/** The input of one cell being edited. Its draft belongs to this row and column only (the component is keyed by
 *  them): Enter, blur, switching cells, leaving the table and hiding the page all save it there (useFieldDraft);
 *  Escape drops it. A refused value stays in the box with the error beside the table. */
function CellEditor({ rowId, field, original, inputMode, invalid, disabled, commit, onClose, onCancel }: {
  rowId: string; field: string; original: string;
  inputMode?: "decimal"; invalid: boolean; disabled: boolean;
  commit: (rowId: string, field: string, original: string, typed: string, keepalive: boolean) => Promise<void>;
  onClose: () => void; onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const draft = useFieldDraft<{ rowId: string; field: string }>({
    target: { rowId, field }, targetKey: `${rowId}\u0000${field}`, committed: original,
    commit: (target, text, { keepalive, base }) => commit(target.rowId, target.field, base, text, !!keepalive),
  });
  const finish = async () => { if (await draft.flush()) onClose(); };
  return (
    <TextField
      ref={inputRef}
      className="cv-table-cell-input"
      inputMode={inputMode}
      aria-invalid={invalid ? true : undefined}
      value={draft.text}
      disabled={disabled}
      onChange={(e) => draft.edit(e.target.value)}
      onBlur={() => void finish()}
      onKeyDown={(e) => {
        if (isEnterKey(e)) { e.preventDefault(); void finish(); }
        else if (isEscapeKey(e)) { e.preventDefault(); draft.discard(); onCancel(); }
      }}
    />
  );
}
/** The view has rows beyond those loaded; `total` is the whole view's count
 *  (left out for a group section, whose share of the rest is unknown). */
type PartialLoad = { total?: number };

function TableSection({
  rows,
  fields,
  fieldMeta,
  partial,
  aggregates,
  onSelectNode,
  onMutated,
  editFieldsOf,
}: {
  rows: ExecRow[];
  fields: string[];
  fieldMeta: NonNullable<ExecResponse["view"]["field_meta"]>;
  partial?: PartialLoad;
  /** The view asked for its totals row (layout_config.aggregates). */
  aggregates: boolean;
  onSelectNode?: (id: string) => void;
  onMutated?: () => void;
  editFieldsOf?: string;
}) {
  const t = useT();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Virtualize past the threshold: only the visible slice of <tr>s is mounted,
  // top/bottom spacer rows keep the scrollbar honest. Below it `win.active` is
  // false and every row renders exactly as before (no scroll container added).
  const win = useRowWindow(rows.length, "tr[data-cv-row]");
  const visibleRows = win.active ? rows.slice(win.start, win.end) : rows;

  const startEdit = (row: ExecRow, field: string) => {
    if (saving) return;
    setError(null);
    setEdit({ nodeId: row.id, field, original: cellValue(row, field) });
  };

  const cancel = () => { setEdit(null); setError(null); };

  // `original`: the cell's text when the edit began (the draft's base), so a commit that fires after the row
  // moved or the cell closed (page hidden, cell switched) still compares with what that edit started from.
  const commit = async (rowId: string, field: string, original: string, typed: string, keepalive: boolean) => {
    const meta = fieldMeta[field];
    // A number cell takes 1,200 and full-width digits; what is still not a
    // number is said here, beside the table, and never sent. The draft stays in the cell.
    const isNumberCell = meta?.type === "number";
    const draft = isNumberCell ? tidyNumberInput(typed) : typed;
    if (isNumberCell && draft !== "" && !isStoredNumber(draft)) {
      setError(t("Enter a number, like 1200 or 12.5."));
      throw new Error("not a number");
    }
    if (draft === original) return;
    setSaving(true);
    setError(null);
    try {
      // The column's schema field decides the stored type (the server applies
      // the same rule); a key with no field is typed from what was entered.
      const value_type = storageType(meta ? meta.type : inferFieldType(draft));
      // A typed value is stored exactly (no padding spaces), as the rule reads it.
      await propertyWriter.set(rowId, field, value_type === "text" ? draft : draft.trim(), { value_type, keepalive });
      onMutated?.();
    } catch (err) {
      setError(writeErrors.message(err));
      throw err;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={win.active ? "cv-table-wrap cv-table-wrap--virt" : "cv-table-wrap"}
      ref={win.active ? win.scrollRef : undefined}
      onScroll={win.active ? win.onScroll : undefined}
    >
      {error && <p className="cv-error cv-table-cell-error">{error}</p>}
      <table className="cv-table">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f} className={BUILT_IN_FIELDS.has(f) ? "cv-table-th--builtin" : ""}>
                {editFieldsOf && !BUILT_IN_FIELDS.has(f) ? (
                  <Pressable type="button" className="cv-table-th-edit" aria-haspopup="dialog" title={t("Field settings")}
                    onClick={(event) => requestFieldEditor({ tagId: editFieldsOf, field: f, at: pointBelow(event.currentTarget) })}>
                    {fieldDisplayName(f, t)}
                  </Pressable>
                ) : fieldDisplayName(f, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {win.active && win.topSpacer > 0 && (
            <tr aria-hidden className="cv-table-virt-spacer">
              <td colSpan={fields.length} style={{ "--cv-spacer-h": `${win.topSpacer}px` } as React.CSSProperties} />
            </tr>
          )}
          {visibleRows.map((row) => (
            <tr key={row.id} data-cv-row>
              {fields.map((f, idx) => {
                const meta = fieldMeta[f];
                const raw = cellValue(row, f);
                // Title (first column): click to open the node.
                if (idx === 0) {
                  return (
                    <td key={f}>
                      <Pressable
                        className="cv-table-title"
                        onClick={() => onSelectNode?.(row.id)}
                        disabled={!onSelectNode}
                        title={t("Open this note")}
                      >
                        {displayTitle(raw)}
                      </Pressable>
                    </td>
                  );
                }
                // Rating fields render read-only stars; empty (0) shows the
                // em-dash like any other empty cell.
                if (meta?.type === "rating" && parseRating(raw) > 0) {
                  return (
                    <td key={f}>
                      <StarRating value={raw} max={meta.max ?? 5} />
                    </td>
                  );
                }
                const editable = !BUILT_IN_FIELDS.has(f);
                const isEditing = editable && edit?.nodeId === row.id && edit.field === f;
                return (
                  <td key={f}>
                    {isEditing ? (
                      <CellEditor
                        key={`${row.id}\u0000${f}`}
                        rowId={row.id} field={f} original={edit!.original}
                        inputMode={meta?.type === "number" ? "decimal" : undefined}
                        invalid={!!error} disabled={saving}
                        commit={commit}
                        onClose={() => setEdit((now) => (now?.nodeId === row.id && now.field === f ? null : now))}
                        onCancel={cancel}
                      />
                    ) : editable ? (
                      <Pressable
                        className={`cv-table-cell-edit${raw === "" ? " cv-table-empty" : ""}`}
                        onClick={() => startEdit(row, f)}
                        title={t("Click to edit")}
                      >
                        {raw || "—"}
                      </Pressable>
                    ) : (
                      <span className={raw === "" ? "cv-table-empty" : ""} title={cellTitle(row, f)}>
                        {raw || "—"}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {win.active && win.bottomSpacer > 0 && (
            <tr aria-hidden className="cv-table-virt-spacer">
              <td colSpan={fields.length} style={{ "--cv-spacer-h": `${win.bottomSpacer}px` } as React.CSSProperties} />
            </tr>
          )}
        </tbody>
        {aggregates && <tfoot>
          <tr>
            {fields.map((f, idx) => (
              <td key={f} className="cv-table-foot" title={partial && idx > 0 ? t("Totals appear once every row is loaded") : undefined}>
                {footerCell(rows, f, idx === 0, fieldMeta[f]?.type, partial)}
              </td>
            ))}
          </tr>
        </tfoot>}
      </table>
    </div>
  );
}

export default function TableLayout({ exec, onSelectNode, onMutated, editFieldsOf }: Props) {
  const t = useT();
  const fields = exec.view.visible_fields.length > 0
    ? exec.view.visible_fields
    : ["title", "updated_at"];
  const fieldMeta = exec.view.field_meta ?? {};
  // Counts and sums are noise on most tables; a view shows them only when
  // its config says so. "N of M rows" while more pages wait is Load more's.
  const aggregates = exec.view.layout_config?.aggregates === true;

  if (exec.rows.length === 0) {
    return <EmptyState size="inline" title={t("No rows match the current filters.")} />;
  }

  const groupBy = exec.view.group_by;
  const more = exec.next !== null && exec.next !== undefined;

  // Ungrouped: single section, no group header.
  if (!groupBy) {
    return (
      <TableSection
        rows={exec.rows}
        fields={fields}
        fieldMeta={fieldMeta}
        partial={more ? { total: exec.total } : undefined}
        aggregates={aggregates}
        onSelectNode={onSelectNode}
        onMutated={onMutated}
        editFieldsOf={editFieldsOf}
      />
    );
  }

  const groups = groupRows(exec.rows, groupBy, exec.view.group_field_options);
  return (
    <div className="cv-groups">
      {groups.map((g) => (
        <section key={g.key} className="cv-group">
          <header className="cv-group-header">
            <span className="cv-group-key">{groupBy}</span>
            <span className="cv-group-val">{groupLabel(g, t)}</span>
            <span className="cv-group-count">{g.rows.length}</span>
          </header>
          <TableSection
            rows={g.rows}
            fields={fields}
            fieldMeta={fieldMeta}
            partial={more ? {} : undefined}
            aggregates={aggregates}
            onSelectNode={onSelectNode}
            onMutated={onMutated}
            editFieldsOf={editFieldsOf}
          />
        </section>
      ))}
    </div>
  );
}
