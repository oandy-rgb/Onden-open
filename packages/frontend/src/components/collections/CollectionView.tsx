// M3.3 — one saved view of a tag or a note, shown as the page of its tab.
//
// Pattern mirrors the SiYuan + AppFlowy convergence (per memory
// project_feature_view_layouts): a CollectionView holds the view config +
// executes its query once; layout-specific renderers consume the same row
// shape and only differ in presentation.
//
// The tab row (components/viewTabs) owns which views exist: adding, naming,
// ordering and removing them. This pane shows the one open tab and what
// belongs to looking at it: its columns/date field, layout, filter and sort.
//
// List and table are built in; kanban, calendar and gallery are view
// modules (docs/architecture/views-as-modules.md): offered only while the
// workspace has imported them, and a view whose module was removed says so
// instead of rendering (its data is kept).

import { useDismiss } from "../../hooks/useEscapeKey";
import type { ExecResponse, ViewLayoutType } from "../../lib/viewExec";
import { reads, viewWriter, writeErrors } from "../../lib/data";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCw, Settings2 } from "lucide-react";

import { t, useT } from "../../lib/i18n";
import "./CollectionView.css";
import { fieldDisplayName } from "../viewLayoutKit";
import QuickAddRow from "./QuickAddRow";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { Menu, MenuItem, Popover, Pressable, usePopover } from "../ui";
import type { FieldDef } from "../../lib/api";
import type { ViewOwner } from "../../lib/data";
import { VIEW_MODULES } from "../../modules";
import { layoutNames, paramOptions } from "./paramOptions";
import LayoutChooser, { layoutChoices, placementChanges, type LayoutChoice } from "./LayoutChooser";
import { freeViewName, nameAfterViewChange } from "../../lib/viewTabs";
import { takeViewSettingsRequest } from "../../lib/viewSettingsRequest";
import { viewNameParts } from "./viewNames";
import { reloadOwnerViews, useOwnerViews, type SavedView } from "../../lib/ownerViews";
import { useLiveRefetch } from "../../lib/liveInvalidation";
import EmptyState from "../EmptyState";
import { Select } from "../ui";

// Only when a person edits a view's filters and sorting; warmed for offline by lib/offlineWarmup.ts.
const ViewBuilder = lazyWithReload(() => import("./ViewBuilder"));

export type { SavedView };

/** The question a layout asks when a view is added (modules/*: `view.param`). */
const viewParamKey = (layout: string) => VIEW_MODULES.find((mod) => mod.id === layout)?.view.param?.key;

/** Whose views these are (docs/architecture/views-as-modules.md 「檢視的來源」):
 *  a tag's, over its members, or a note's, over its children. `name` is the
 *  tag's name or the note's title. */
export type ViewSource = ViewOwner & { name: string };

type Props = {
  source: ViewSource;
  /** The saved view this pane shows (the open tab). */
  viewId: string;
  /** Fields defined on the supertag's schema — used as the default
   *  visible_fields when the user creates a new view. */
  schemaFieldKeys?: string[];
  /** Optional: open a node by id (passed through to the row renderer). */
  onSelectNode?: (id: string) => void;
  /** The tag's (or the note's children's) fields with their types: what a
   *  calendar, board or cards view is changed to be placed by. */
  schemaFields?: FieldDef[];
  /** False hides what changes the view (layout, columns, filters); the server
   *  only accepts those from whoever may edit the owner. */
  canManage?: boolean;
  /** An editable copy of an inherited view was made: open its tab. */
  onOpenView?: (viewId: string) => void;
};

export default function CollectionView({ source, viewId, schemaFieldKeys = [], schemaFields, onSelectNode, canManage = true, onOpenView }: Props) {
  const t = useT();
  const { kind, id: ownerId, name: ownerName } = source;
  const owner = useMemo<ViewOwner>(() => ({ kind, id: ownerId }), [kind, ownerId]);
  const isTag = kind === "tag";
  const { views, status } = useOwnerViews(owner);
  const activeView = views.find((v) => v.id === viewId) ?? null;
  const [optionsOpen, setOptionsOpen] = useState(false);
  // A layout that asks for a field first: the options popover shows that step.
  const [switchTo, setSwitchTo] = useState<LayoutChoice | null>(null);
  const closeOptions = () => { setOptionsOpen(false); setSwitchTo(null); };
  const optionsMenu = usePopover<HTMLButtonElement>({ open: optionsOpen, onClose: closeOptions, placement: "bottom-end" });
  // The rows on screen and the view they belong to: a page from Load more is
  // appended only to the view (and offset) it was asked for.
  const [exec, setExec] = useState<(ExecResponse & { viewId: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);

  // The rows loaded so far, read inside loadExec without making it change
  // (a re-run after an edit keeps as many rows as Load more had brought).
  const loadedRef = useRef(0);
  loadedRef.current = exec?.rows.length ?? 0;
  // The view whose rows are on screen; a page landing for another is dropped.
  const shownViewRef = useRef<string | null>(null);
  shownViewRef.current = viewId;

  /** Run the view from the first page. `keep` re-reads as many rows as are
   *  loaded now (after an edit), page by page, instead of collapsing to one. */
  const loadExec = useCallback(async (id: string, opts: { keep?: boolean } = {}) => {
    try {
      const want = opts.keep ? loadedRef.current : 0;
      let res = await reads.views.run<ExecResponse>(owner, id);
      while (res.next !== null && res.rows.length < want) {
        const page = await reads.views.run<ExecResponse>(owner, id, { offset: res.next });
        res = { ...page, rows: [...res.rows, ...page.rows] };
      }
      if (shownViewRef.current === id) { setError(null); setExec({ ...res, viewId: id }); }
    } catch (err) {
      setError(writeErrors.requestMessage(err, t("Failed to run view query.")));
    }
  }, [owner, t]);

  // Load more: the next page appended (the table footer totals wait for it).
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!exec || exec.next === null || exec.viewId !== viewId) return;
    const { viewId: shown, next } = exec;
    setLoadingMore(true);
    try {
      const page = await reads.views.run<ExecResponse>(owner, shown, { offset: next });
      setExec((prev) => prev?.viewId === shown && prev.next === next
        ? { ...page, rows: [...prev.rows, ...page.rows], viewId: shown }
        : prev);
    } catch (err) {
      setError(writeErrors.requestMessage(err, t("Failed to run view query.")));
    } finally {
      setLoadingMore(false);
    }
  };

  // Someone else's change (another device, a teammate, an agent) re-runs the
  // open view, so a moved date lands on its new day (GAP-158).
  useLiveRefetch("changed", () => (activeView ? loadExec(viewId, { keep: true }) : undefined), { collapseEcho: true, onVisible: true, onOnline: true });
  // The view's own query settings (not its name or place) decide what runs.
  const queryKey = activeView ? JSON.stringify([activeView.layout, activeView.group_by, activeView.filters, activeView.sorts, activeView.visible_fields, activeView.layout_config]) : null;
  useEffect(() => {
    if (queryKey === null) { setExec(null); return; }
    void loadExec(viewId);
  }, [viewId, queryKey, loadExec]);
  useEffect(() => { setBuilderOpen(false); }, [viewId]);
  // A copy made by 「Make a variation…」 opens on its settings, where the person changes what sets it apart.
  const hasActiveView = !!activeView;
  useEffect(() => { if (hasActiveView && takeViewSettingsRequest(viewId)) setOptionsOpen(true); }, [viewId, hasActiveView]);

  const createView = async (input: Parameters<typeof viewWriter.create>[1]) => {
    setBusy(true);
    try {
      // Needs the server (it mints the view id); refused offline with a message.
      const id = await viewWriter.create(owner, input);
      await reloadOwnerViews(owner);
      if (id) onOpenView?.(id);
    } catch {
      // Reported once by the view writer.
    } finally {
      setBusy(false);
    }
  };

  /** The name the open view gets from `changes`: an automatic name follows its
   *  kind and what sets it apart (the date or column field, a filter); a name
   *  the person typed stays (null). */
  const nameAfter = (changes: Partial<SavedView>): string | null => {
    if (!activeView || changes.name !== undefined) return null;
    return nameAfterViewChange(
      activeView.name, viewNameParts(activeView, schemaFields), viewNameParts({ ...activeView, ...changes }, schemaFields),
      views.filter((v) => !v.inherited_from && v.id !== activeView.id).map((v) => v.name),
    );
  };

  /** Change the open view, then read it back; the query re-runs itself. */
  const updateView = async (changes: Parameters<typeof viewWriter.update>[2]) => {
    if (!activeView) return;
    setBusy(true);
    try {
      // Queued offline / on a transient failure and replayed; a refusal is
      // reported once by the view writer.
      const name = nameAfter(changes);
      await viewWriter.update(owner, activeView.id, name ? { ...changes, name } : changes);
      await reloadOwnerViews(owner);
    } catch {
      // Reported by the view writer.
    } finally {
      setBusy(false);
    }
  };

  // An inherited view is changed on the tag it comes from; here it can only be copied.
  const editable = canManage && !activeView?.inherited_from;
  const copyView = async (view: SavedView) => {
    const taken = views.filter((v) => !v.inherited_from).map((v) => v.name);
    await createView({
      name: freeViewName(view.name, taken), layout: view.layout, filters: view.filters, sorts: view.sorts, group_by: view.group_by,
      visible_fields: view.visible_fields, layout_config: view.layout_config,
    });
  };
  // The field a calendar or cards view was added with, changeable from the
  // options menu (the board picks its columns in the toolbar).
  const activeParam = VIEW_MODULES.find((mod) => mod.id === activeView?.layout && mod.view.param && mod.view.param.key !== "group_by")?.view.param ?? null;
  const [paramValue, setParamValue] = useState<string | null>(null);
  // Back and Esc close the open edit panel (the layout's field, or filter / sort / group) without saving it.
  useDismiss(() => { if (paramValue !== null) setParamValue(null); else setBuilderOpen(false); },
    (paramValue !== null && !!activeParam) || (builderOpen && editable && !!activeView));
  const saveParam = async () => {
    if (!activeView || !activeParam || paramValue === null) return;
    const value = paramValue;
    setParamValue(null);
    await updateView(placementChanges(activeParam, value, activeView));
  };

  /** Change the open view's layout. A name that was the old layout's automatic
   *  one follows the new layout; the field the layout asks for is stored as
   *  when the view is added. */
  const switchLayout = async (choice: LayoutChoice, field: string) => {
    if (!activeView) return;
    closeOptions();
    await updateView({
      layout: choice.layout,
      ...(choice.param && field ? placementChanges(choice.param, field, activeView) : {}),
    });
  };

  // The board's columns come from the same fields as when a board is added.
  const groupParam = activeView && viewParamKey(activeView.layout) === "group_by" ? VIEW_MODULES.find((mod) => mod.id === activeView.layout)!.view.param! : null;
  const groupOptions = groupParam ? paramOptions(groupParam, schemaFields ?? []).map((o) => ({ ...o, label: o.builtIn ? t(o.label) : o.label })) : [];
  // A column field the view already has but the tag no longer offers stays shown.
  if (activeView?.group_by && !groupOptions.some((o) => o.key === activeView.group_by)) {
    groupOptions.push({ key: activeView.group_by, label: fieldDisplayName(activeView.group_by, t) });
  }

  const groupByControl = editable && activeView && groupParam ? (
    <label className="cv-groupby" title={t("Which field becomes the kanban columns")}>
      <span className="cv-groupby-label">{t("Group by")}</span>
      <Select
        className="cv-groupby-select"
        value={activeView.group_by ?? ""}
        disabled={busy || groupOptions.length === 0}
        onChange={(e) => void updateView(placementChanges(groupParam, e.target.value, activeView))}
      >
        <option value="">{groupOptions.length === 0 ? t("(no fields)") : t("(auto)")}</option>
        {groupOptions.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </Select>
    </label>
  ) : null;

  return (
    <div className="cv-root">
      {activeView && (
        <div className="cv-bar">
          <div className="cv-bar-groupby">{groupByControl}</div>
          <div className="cv-bar-tools">
            {editable && <Pressable
              ref={optionsMenu.anchor}
              type="button"
              className="cv-bar-btn cv-bar-icon"
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              aria-label={t("View options")}
              title={t("View options")}
              onClick={() => setOptionsOpen((open) => !open)}
            >
              <Settings2 size={15} aria-hidden="true" />
            </Pressable>}
          </div>
        </div>
      )}
      {optionsOpen && activeView && switchTo && (
        <Popover popover={optionsMenu} className="cv-add-view-panel" label={t("View options")}>
          <LayoutChooser
            choices={[switchTo]} initial={switchTo} fields={schemaFields ?? []} ownerKind={kind} busy={busy}
            submitLabel={t("Change layout")} onBack={() => setSwitchTo(null)}
            onChoose={(choice, field) => void switchLayout(choice, field)}
          />
        </Popover>
      )}
      {optionsOpen && activeView && !switchTo && (
        <Menu popover={optionsMenu} label={t("View options")}>
          {editable && <>
            {activeParam && (
              <MenuItem onSelect={() => setParamValue(String(activeView.layout_config?.[activeParam.key] ?? ""))}>{t("{question}…", { question: t(activeParam.label) })}</MenuItem>
            )}
            {layoutChoices().map((choice) => (
              <MenuItem key={choice.layout} checked={activeView.layout === choice.layout} disabled={busy} keepOpen={!!choice.param}
                onSelect={() => { if (choice.param) setSwitchTo(choice); else void switchLayout(choice, ""); }}>
                {t(choice.title)}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => setBuilderOpen((o) => !o)}>{t("Filter, sort and group this view")}</MenuItem>
          </>}
        </Menu>
      )}

      {paramValue !== null && activeView && activeParam && (
        <form className="cv-param-edit" onSubmit={(event) => { event.preventDefault(); void saveParam(); }}>
          <label>
            <span>{t(activeParam.label)}</span>
            <Select value={paramValue} onChange={(event) => setParamValue(event.target.value)}>
              <option value="">{t("(automatic)")}</option>
              {paramOptions(activeParam, schemaFields ?? []).map((o) => <option key={o.key} value={o.key}>{o.builtIn ? t(o.label) : o.label}</option>)}
            </Select>
          </label>
          <Pressable type="submit" className="cv-layout-btn cv-layout-btn--active" disabled={busy}>{t("Save")}</Pressable>
          <Pressable type="button" className="cv-layout-btn" onClick={() => setParamValue(null)}>{t("Cancel")}</Pressable>
        </form>
      )}
      {editable && builderOpen && activeView && (
        <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
          <ViewBuilder
            owner={owner}
            view={activeView}
            fieldKeys={schemaFieldKeys}
            nameAfter={nameAfter}
            onSaved={() => {
              // Persist landed; pull fresh config (for filter/sort echo) and
              // re-run the query so the result reflects the new clauses.
              void reloadOwnerViews(owner);
              void loadExec(viewId);
            }}
          />
        </Suspense>
      )}

      {error && <p className="cv-error">{error}</p>}
      {status === "loading" && !activeView && <EmptyState size="inline" title={t("Loading views…")} />}
      {status !== "loading" && !activeView && (
        <p className="cv-empty">
          <RotateCw size={12} className="cv-icon-middle" />{" "}
          {isTag ? t("This view is gone. Pick another tab of #{name}.", { name: ownerName })
            : t("This view is gone. Pick another tab of {name}.", { name: ownerName })}
        </p>
      )}
      {activeView?.inherited_from && (
        <div className="cv-inherited">
          <span>{t("From #{name} — change it there, or make a copy for #{tag}.", { name: activeView.inherited_name ?? "", tag: ownerName })}</span>
          {canManage && (
            <Pressable type="button" className="cv-layout-btn" disabled={busy} onClick={() => void copyView(activeView)}>{t("Copy as this tag's own")}</Pressable>
          )}
        </div>
      )}
      {exec && activeView && (
        <>
          {renderLayout(activeView.layout as ViewLayoutType, exec, {
            viewId: activeView.id,
            onSelectNode,
            onMutated: () => void loadExec(viewId, { keep: true }),
            // A tag's owner changes its fields from a column name (tagPage/FieldPopover).
            editFieldsOf: isTag && canManage ? ownerId : undefined,
          })}
          {exec.next !== null && exec.viewId === viewId && (
            <div className="cv-more">
              <span className="cv-more-count">
                {exec.total === undefined
                  ? t("{n} rows loaded", { n: exec.rows.length })
                  : t("{n} of {total} rows", { n: exec.rows.length, total: exec.total })}
              </span>
              <Pressable className="cv-layout-btn" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t("Loading…") : t("Load more")}
              </Pressable>
            </div>
          )}
          {/* In-view quick-add: type a title + Enter mints a node and applies
              this collection's class tag, then re-runs the query so it lands
              in the view. Reuses the QuickCapture create-then-tag pattern.
              On a note's views it makes a sub-note: only for whoever may
              edit the note (the server would refuse the others). */}
          {(isTag || canManage) && (
            <QuickAddRow
              source={source}
              onCreated={() => loadExec(activeView.id, { keep: true })}
            />
          )}
        </>
      )}
    </div>
  );
}

export function renderLayout(
  layout: ViewLayoutType,
  exec: ExecResponse,
  ctx: { viewId: string; onSelectNode?: (id: string) => void; onMutated?: () => void; editFieldsOf?: string },
) {
  const mod = VIEW_MODULES.find((m) => m.id === layout);
  if (!mod) {
    return (
      <EmptyState size="inline" title={t("This view's layout isn't supported. Switch to {layouts}.", { layouts: layoutNames() })} />
    );
  }
  const { Layout } = mod.view;
  // Keyed by view: a layout keeps its own state (the calendar's month) per view.
  // A layout's code loads when its first view is drawn (modules/<layout>/index).
  return (
    <Suspense key={ctx.viewId} fallback={<EmptyState size="inline" title={t("Loading…")} />}>
      <Layout viewId={ctx.viewId} exec={exec} onSelectNode={ctx.onSelectNode} onMutated={ctx.onMutated} editFieldsOf={ctx.editFieldsOf} />
    </Suspense>
  );
}
