// collection-field-authoring — in-UI filter / sort / group-by builder.
//
// CollectionView (f66b999) can RENDER saved views, but until now they were
// only ever created table-only with hardcoded visible_fields; the filters,
// sorts and group_by that make a database view useful were API/YAML-only.
// This builder closes that gap entirely in the UI: it edits the SAME view
// config the backend already persists (collection_views.filters / sorts /
// group_by / visible_fields), through the existing
//   PATCH /api/tags/:tagId/views/:viewId (a note's: /api/nodes/:id/views/:viewId)
// route — no new endpoint, no new column. The operator set mirrors the
// backend's services/filter/sqlClauses.ts (the trust boundary), so anything
// the builder offers, the executor actually runs.
//
// Field choices = the supertag's schema field keys + the built-in columns the
// executor whitelists for sort (title / updated_at / created_at / sort_order).

import type { FilterOpName } from "@onden/markdown";
import { useCallback, useEffect, useRef, useState } from "react";
import { createSaveDebounce, SAVE_DEBOUNCE_MS } from "../../lib/persistScheduler";
import { onPageHide } from "../../lib/pageHide";
import { fieldDisplayName } from "../viewLayoutKit";
import { Plus, Trash2, Filter, ArrowUpDown, Rows3 } from "lucide-react";
import { viewWriter, writeErrors, type ViewOwner } from "../../lib/data";
import type { SavedView } from "./CollectionView";
import { useT } from "../../lib/i18n";
import EmptyState from "../EmptyState";
import { placementChanges } from "./LayoutChooser";
import { Checkbox, Pressable, Select, TextField } from "../ui";

// The ops are @onden/markdown's FILTER_OP_NAMES, the list the server validates
// against (a value-bearing op needs a value input; empty/nempty don't).
const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "is", needsValue: true },
  { value: "ne", label: "is not", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "empty", label: "is empty", needsValue: false },
  { value: "nempty", label: "is not empty", needsValue: false },
  { value: "gt", label: "is greater than", needsValue: true },
  { value: "gte", label: "is at least", needsValue: true },
  { value: "lt", label: "is less than", needsValue: true },
  { value: "lte", label: "is at most", needsValue: true },
];
type FilterOp = FilterOpName;
interface FilterClause { field: string; op: FilterOp; value?: string }
interface SortClause { field: string; dir: "asc" | "desc" }

// Built-in columns the executor whitelists for sort (collectionViewQuery
// SORT_WHITELIST) + the always-available identity columns for filtering.
const BUILT_IN_SORTS = ["title", "updated_at", "created_at", "sort_order"];

type ViewChanges = { filters?: FilterClause[]; sorts?: SortClause[]; group_by?: string | null; layout_config?: Record<string, unknown>; visible_fields?: string[] };

type Props = {
  /** The tag or note the view belongs to. */
  owner: ViewOwner;
  view: SavedView;
  /** Schema field keys for this supertag — the attribute fields the user can
   *  filter / sort / group by, on top of the built-ins. */
  fieldKeys: string[];
  /** Called after a successful persist so the host can re-exec the query. */
  onSaved: () => void;
  /** The name an automatic view name becomes with these changes; null keeps it. */
  nameAfter?: (changes: ViewChanges) => string | null;
};

export default function ViewBuilder({ owner, view, fieldKeys, onSaved, nameAfter }: Props) {
  const t = useT();
  const fieldLabel = (k: string) => fieldDisplayName(k, t);
  // Local working copy — edits are debounced into one PATCH so dragging a
  // value input doesn't fire a request per keystroke.
  const [filters, setFilters] = useState<FilterClause[]>(() => (view.filters as FilterClause[]) ?? []);
  const [sorts, setSorts] = useState<SortClause[]>(() => (view.sorts as SortClause[]) ?? []);
  const [groupBy, setGroupBy] = useState<string | null>(view.group_by ?? null);
  const [totals, setTotals] = useState(view.layout_config?.aggregates === true);
  const [status, setStatus] = useState<"idle" | "saving" | "queued" | "error">("idle");
  const debounce = useRef(createSaveDebounce(SAVE_DEBOUNCE_MS.view)).current;
  // Every change inside one debounce window is sent together: a filter
  // removal followed by a sort change within 400ms used to send only the sorts
  // and lose the filter change (GAP-123).
  const pending = useRef<{ viewId: string; changes: ViewChanges } | null>(null);

  // Re-seed when the active view changes (chip switch) — otherwise the builder
  // keeps showing the previous view's clauses.
  useEffect(() => {
    setFilters((view.filters as FilterClause[]) ?? []);
    setSorts((view.sorts as SortClause[]) ?? []);
    setGroupBy(view.group_by ?? null);
    setTotals(view.layout_config?.aggregates === true);
    setStatus("idle");
  }, [view.id, view.filters, view.sorts, view.group_by, view.layout_config]);

  const nameAfterRef = useRef(nameAfter);
  nameAfterRef.current = nameAfter;
  const flush = useCallback(async () => {
    debounce.cancel();
    const batch = pending.current;
    pending.current = null;
    if (!batch) return;
    try {
      // The view writer queues it offline / on a transient failure and
      // replays it; a refusal is reported once by the writer.
      const name = nameAfterRef.current?.(batch.changes);
      const result = await viewWriter.update(owner, batch.viewId, name ? { ...batch.changes, name } : batch.changes);
      setStatus(result.status === "queued" ? "queued" : "idle");
      onSaved();
    } catch {
      setStatus("error");
    }
  }, [owner, onSaved, debounce]);

  const persist = useCallback((patch: ViewChanges) => {
    setStatus("saving");
    if (pending.current && pending.current.viewId !== view.id) void flush();
    pending.current = { viewId: view.id, changes: { ...pending.current?.changes, ...patch } };
    debounce.run(() => { void flush(); });
  }, [view.id, flush, debounce]);

  // Leaving the builder (closing the panel) or the page (closed, hidden) sends what is pending instead of
  // dropping it with the timer. The latest flush via a ref.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const stop = onPageHide(() => { void flushRef.current(); });
    return () => { stop(); void flushRef.current(); };
  }, []);

  // ── Filters ──────────────────────────────────────────────────────────────
  const allFilterFields = [...BUILT_IN_SORTS.filter((f) => f !== "sort_order"), ...fieldKeys];
  const addFilter = () => {
    const next = [...filters, { field: allFilterFields[0] ?? "title", op: "contains" as FilterOp, value: "" }];
    setFilters(next);
    persist({ filters: next });
  };
  const patchFilter = (i: number, p: Partial<FilterClause>) => {
    const next = filters.map((f, idx) => (idx === i ? { ...f, ...p } : f));
    setFilters(next);
    persist({ filters: next });
  };
  const removeFilter = (i: number) => {
    const next = filters.filter((_, idx) => idx !== i);
    setFilters(next);
    persist({ filters: next });
  };

  // ── Sorts ────────────────────────────────────────────────────────────────
  const allSortFields = [...BUILT_IN_SORTS, ...fieldKeys];
  const addSort = () => {
    const next = [...sorts, { field: allSortFields[0] ?? "title", dir: "asc" as const }];
    setSorts(next);
    persist({ sorts: next });
  };
  const patchSort = (i: number, p: Partial<SortClause>) => {
    const next = sorts.map((s, idx) => (idx === i ? { ...s, ...p } : s));
    setSorts(next);
    persist({ sorts: next });
  };
  const removeSort = (i: number) => {
    const next = sorts.filter((_, idx) => idx !== i);
    setSorts(next);
    persist({ sorts: next });
  };

  // ── Group-by ───────────────────────────────────────────────────────────────
  const setGroup = (field: string | null) => {
    setGroupBy(field);
    persist(placementChanges({ key: "group_by" }, field ?? "", view));
  };

  // The totals row is a table feature (layout_config.aggregates); the rest of
  // layout_config rides along because the view PATCH replaces it whole.
  const setShowTotals = (on: boolean) => {
    setTotals(on);
    persist({ layout_config: { ...view.layout_config, aggregates: on } });
  };

  return (
    <div className="cv-builder">
      <div className="cv-builder-status" aria-live="polite">
        {status === "saving" ? t("Saving…") : status === "queued" ? writeErrors.queuedMessage() : status === "error" ? t("Save failed") : ""}
      </div>

      {/* Filters */}
      <div className="cv-builder-group">
        <div className="cv-builder-head">
          <Filter size={12} /> <span>{t("Filter")}</span>
        </div>
        {filters.length === 0 && <EmptyState size="inline" as="span" title={t("No filters — showing every #note.")} />}
        {filters.map((f, i) => {
          const op = FILTER_OPS.find((o) => o.value === f.op) ?? FILTER_OPS[0];
          return (
            <div key={i} className="cv-builder-row">
              <Select className="cv-builder-input" value={f.field} onChange={(e) => patchFilter(i, { field: e.target.value })}>
                {allFilterFields.map((k) => <option key={k} value={k}>{fieldLabel(k)}</option>)}
              </Select>
              <Select className="cv-builder-input cv-builder-op" value={f.op} onChange={(e) => patchFilter(i, { op: e.target.value as FilterOp })}>
                {FILTER_OPS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
              </Select>
              {op.needsValue && (
                <TextField
                  className="cv-builder-input"
                  placeholder={t("value")}
                  value={f.value ?? ""}
                  onChange={(e) => patchFilter(i, { value: e.target.value })}
                />
              )}
              <Pressable className="cv-builder-del" onClick={() => removeFilter(i)} title={t("Remove filter")} aria-label={t("Remove filter")}>
                <Trash2 size={12} />
              </Pressable>
            </div>
          );
        })}
        <Pressable className="cv-builder-add" onClick={addFilter}><Plus size={11} /> {t("Add filter")}</Pressable>
      </div>

      {/* Sorts */}
      <div className="cv-builder-group">
        <div className="cv-builder-head">
          <ArrowUpDown size={12} /> <span>{t("Sort")}</span>
        </div>
        {sorts.length === 0 && <EmptyState size="inline" as="span" title={t("Default order.")} />}
        {sorts.map((s, i) => (
          <div key={i} className="cv-builder-row">
            <Select className="cv-builder-input" value={s.field} onChange={(e) => patchSort(i, { field: e.target.value })}>
              {allSortFields.map((k) => <option key={k} value={k}>{fieldLabel(k)}</option>)}
            </Select>
            <Select className="cv-builder-input cv-builder-op" value={s.dir} onChange={(e) => patchSort(i, { dir: e.target.value as "asc" | "desc" })}>
              <option value="asc">{t("ascending")}</option>
              <option value="desc">{t("descending")}</option>
            </Select>
            <Pressable className="cv-builder-del" onClick={() => removeSort(i)} title={t("Remove sort")} aria-label={t("Remove sort")}>
              <Trash2 size={12} />
            </Pressable>
          </div>
        ))}
        <Pressable className="cv-builder-add" onClick={addSort}><Plus size={11} /> {t("Add sort")}</Pressable>
      </div>

      {/* Group-by */}
      <div className="cv-builder-group">
        <div className="cv-builder-head">
          <Rows3 size={12} /> <span>{t("Group by")}</span>
        </div>
        <Select
          className="cv-builder-input"
          value={groupBy ?? ""}
          onChange={(e) => setGroup(e.target.value || null)}
        >
          <option value="">{t("— none —")}</option>
          {[...BUILT_IN_SORTS.filter((f) => f !== "sort_order" && f !== "updated_at" && f !== "created_at"), ...fieldKeys].map((k) => (
            <option key={k} value={k}>{fieldLabel(k)}</option>
          ))}
        </Select>
      </div>

      {view.layout === "table" && (
        <div className="cv-builder-group">
          <label className="cv-builder-check">
            <Checkbox checked={totals} onChange={(e) => setShowTotals(e.target.checked)} />
            <span>{t("Show totals row")}</span>
          </label>
          <EmptyState size="inline" as="span" title={t("Adds the row count, and the sum and average of number columns, under the table.")} />
        </div>
      )}
    </div>
  );
}
