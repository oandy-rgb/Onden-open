import { Suspense } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { loadCollectionView } from "../collections";
import { useT } from "../../lib/i18n";
import { useNode, useOnline } from "../../lib/appStore";
import { useOwnerViews } from "../../lib/ownerViews";
import { NOTE_VIEW_MODULES } from "../../modules";
import RegionErrorBoundary from "../RegionErrorBoundary";
import type { ViewOwnerInfo } from "./useViewOwner";
import "./ViewTabs.css";

/** The page of a saved-view tab: the owner's name over the view, using the
 *  whole width of the note area. A tab a module draws from the note itself
 *  (「簡報」) is that module's pane; every other is a collection view. */
// The view's rows (layouts and all) load when a saved-view tab first opens; lib/offlineWarmup.ts fetches them ahead.
const CollectionView = lazyWithReload(loadCollectionView);
// The field popover a table's column names open loads when a tag's page shows.
const TagFieldsHost = lazyWithReload(() => import("../tagPage").then((m) => ({ default: m.TagFieldsHost })));

export default function OwnerViewPane({ info, viewId, onOpenNote, onOpenView, onSaved }: {
  info: ViewOwnerInfo;
  /** Refresh app data after a field edit (a tag's field settings). */
  onSaved?: () => void;
  viewId: string;
  onOpenNote: (id: string) => void;
  onOpenView: (viewId: string) => void;
}) {
  const t = useT();
  const { owner, fields, canManage } = info;
  const { views } = useOwnerViews(owner);
  const node = useNode(owner.kind === "node" ? owner.id : null) ?? null;
  const layout = views.find((view) => view.id === viewId)?.layout;
  const noteView = node ? NOTE_VIEW_MODULES.find((mod) => mod.id === layout) : undefined;
  const online = useOnline();
  const fieldKeys = fields.map((field) => field.name ?? field.key ?? "").filter(Boolean);
  if (noteView && node) {
    const { Pane } = noteView.noteView;
    return (
      <section className={`view-pane view-pane-note${noteView.noteView.fillsHeight ? " view-pane-fill" : ""}`} aria-label={t("Views of {name}", { name: owner.name })}>
        <RegionErrorBoundary region="note-view" resetKeys={[owner.id, viewId]}>
          <Suspense fallback={null}><Pane node={node} canEdit={canManage} onOpenNode={onOpenNote} /></Suspense>
        </RegionErrorBoundary>
      </section>
    );
  }
  return (
    <section className="view-pane" aria-label={t("Views of {name}", { name: owner.name })}>
      <h1 className="view-pane-title">{owner.kind === "tag" ? `#${owner.name}` : owner.name}</h1>
      <RegionErrorBoundary region="collection-view" resetKeys={[owner.id, viewId]}>
        <Suspense fallback={null}>
          <CollectionView source={owner} viewId={viewId} schemaFieldKeys={fieldKeys} schemaFields={fields}
            onSelectNode={onOpenNote} canManage={canManage} onOpenView={onOpenView} />
        </Suspense>
      </RegionErrorBoundary>
      {owner.kind === "tag" && canManage && <Suspense fallback={null}><TagFieldsHost tagId={owner.id} online={online} onSaved={onSaved} /></Suspense>}
    </section>
  );
}
