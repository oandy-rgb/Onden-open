import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { reads } from "../../lib/data";
import { makeWebsiteWriter } from "./websiteWriter";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { getAppState } from "../../lib/appStore";
import PublishPreviewDialog from "./PublishPreviewDialog";
import { siteSettingsFromConfig } from "../../lib/siteSettings";
import "./PublishedSnapshots.css";
import { homePublishBody, usePublishReview } from "./usePublishReview";
import { Link, Pressable } from "../../components/ui";

/** The publish log (PublishLog) hands it the connection state and a refresh. */
export type PublishedSnapshotsProps = { online: boolean; onRefresh: () => void };

export type Snapshot = { id: string; title: string; node_count: number; created_at: string; artifact_ref: string | null };

// The shared publish path: an idempotency key, no publishing over unsynced
// changes, and a failure reported as a toast in plain words.
const writer = makeWebsiteWriter();

// The website's published snapshots and
// 「發布…」 — publish the site as it is saved. A snapshot is what readers get
// (model B), so this goes through the same preview and hash as the Studio's
// Publish →. It loads its own list, so the timeline shows it without first
// visiting the site studio.
export default function PublishedSnapshots({ online, onRefresh }: PublishedSnapshotsProps) {
  const t = useT();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const review = usePublishReview(writer);
  const load = useCallback(async () => {
    try { setSnapshots(await reads.modules.website.snapshots<Snapshot>()); } catch { /* the section stays as it was */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const confirm = async (): Promise<boolean> => {
    if (!(await review.confirm())) return false; // reported; a stale preview shows the new one
    await load();
    onRefresh();
    return true;
  };

  return (
    <div className="tl-publish-section">
      <div className="tl-publish-header">
        <span className="tl-publish-title">{t("Published")}</span>
        {snapshots[0]?.artifact_ref && (
          <Link className="tl-publish-link" href={snapshots[0].artifact_ref} target="_blank" rel="noreferrer">
            {t("View Site ↗")}
          </Link>
        )}
        <Pressable
          className="timeline-snapshot-btn"
          onClick={() => void review.start(async () => homePublishBody(siteSettingsFromConfig(getAppState().data.site_config)))}
          disabled={!online || review.loading || review.publishing}
          title={t("Publish the site as it is saved — you see what will go out first")}
        >
          <Send size={13} />
          {review.loading ? "…" : t("Publish…")}
        </Pressable>
      </div>
      {snapshots.length > 0 && (
        <div className="tl-publish-list">
          {snapshots.map((snap, i) => (
            <div className="tl-publish-row" key={snap.id}>
              <span className="tl-publish-index">#{snapshots.length - i}</span>
              <span className="tl-publish-date">{dateLabel(snap.created_at, "shortDateTime")}</span>
              <span className="tl-publish-nodes">{t("{n} nodes", { n: snap.node_count })}</span>
            </div>
          ))}
        </div>
      )}
      {review.pending && (
        <PublishPreviewDialog pending={review.pending} outcome={review.outcome} publishing={review.publishing} online={online}
          onConfirm={confirm} onCancel={review.cancel} onChanged={() => void review.refresh()} />
      )}
    </div>
  );
}
