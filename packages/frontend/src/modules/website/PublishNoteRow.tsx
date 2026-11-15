import { pageOrigin } from "../../lib/api";
import { useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { useTransientFlag } from "../../hooks/useTransientFlag";
import { Globe } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../../lib/i18n";
import { getAppState, hasChildNote, useOnline, useAllNodes } from "../../lib/appStore";
import { putOnSite } from "./putOnSite";
import { reads, propertyWriter, runBackgroundWrite } from "../../lib/data";
import { useIsOwner } from "../../lib/capabilities";
import { siteSettingsFromConfig } from "../../lib/siteSettings";
import { useSpaces } from "../../lib/spaces";
import type { NoteHeaderActionProps } from "../types";
import { PUBLISHED_ATTR, PUBLISHED_FLAG, siteStanding } from "./publishBlocker";
import PublishPreviewDialog from "./PublishPreviewDialog";
import { homePublishBody, usePublishReview } from "./usePublishReview";
import { makeWebsiteWriter } from "./websiteWriter";
import { Button, Link, Pressable } from "../../components/ui";
import { subtreeIdsOf } from "../../lib/treeWalk";

// The website module's row in the info panel's 「功能」 section
// (FrontendModule.noteFunctionRow): where this note stands on the site, in
// words, and what can be done about it — publish, update, copy the link, keep
// it off. The panel shows it only while the website module is imported, the
// note is editable and in a space that publishes (noteFunctionRows.ts): every
// note there is on the site unless kept off (publishBlocker.siteStanding), so
// the row says which, and a note the site leaves out for good (hidden, or in a
// space that does not publish) gets no row rather than a sentence about what
// it cannot do.
//
// Publishing is two steps the row keeps apart in its words: a note in a space
// that publishes belongs on the site, and readers get it with the next publish
// of the site (the site is the last published snapshot, site-render-model.md),
// while keeping it off (「不發布」, `_published` 'false') takes it down at once.
// The state comes from GET /api/site/status/:id; the owner publishes from here
// with the same preview and confirmation as the Website screen (usePublishReview).

const writer = makeWebsiteWriter();

export default function PublishNoteRow({ node, readOnly }: NoteHeaderActionProps) {
  const t = useT();
  const online = useOnline();
  const { spaces } = useSpaces(online);
  const [copied, flashCopied] = useTransientFlag();
  const isOwner = useIsOwner();
  const review = usePublishReview(writer);

  const standing = siteStanding(node, spaces, hasChildNote(node.id));
  const onSite = standing.on;
  // 「不發布」 on a note with notes under it (owner 2026-11-14): how many of those are on the
  // site, asked once before marking, and shown on the row of a note kept off alone.
  const nodes = useAllNodes();
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const below = useMemo(() => {
    const under = subtreeIdsOf(nodes, node.id);
    return nodes.filter((n) => n.id !== node.id && under.has(n.id) && siteStanding(n, spaces, hasChildNote(n.id)).on).length;
  }, [nodes, spaces, node.id]);
  // The site leaves out a hidden note and a note whose space doesn't publish,
  // whatever it says (publishBlocker.ts): no row for those.
  const blocked = !standing.on && (standing.reason === "hidden" || standing.reason === "space");

  // Where the note stands on the site, read when the row shows and again
  // after a publish. Keyed by what it answered for, so an earlier publish's
  // answer never shows.
  const [publishes, setPublishes] = useState(0);
  const statusKey = `${node.id}:${publishes}`;
  const [status, setStatus] = useState<{ key: string; state: Awaited<ReturnType<typeof reads.modules.website.noteSiteStatus>>["state"] } | null>(null);
  useEffect(() => {
    // Taking a note down forgets the answer: marking it again starts from the server's word.
    if (!onSite) { setStatus(null); return; }
    if (!online) return;
    let current = true;
    reads.modules.website.noteSiteStatus(node.id).then(
      (r) => { if (current) setStatus({ key: statusKey, state: r.state }); },
      () => {/* no state line; the buttons still work */},
    );
    return () => { current = false; };
  }, [onSite, online, node.id, statusKey]);
  const siteState = onSite && online && status?.key === statusKey ? status.state : null;

  // The page's address as readers reach it: read off the served site by id
  // (GET /api/site/url/:id, D42), never built from the live slug — the site
  // may have renamed a clashing slug, and a note renamed after Publish keeps
  // its old address until the next one. Null until the site serves the note.
  const [served, setServed] = useState<{ id: string; path: string | null } | null>(null);
  const live = siteState === "current" || siteState === "outdated";
  useEffect(() => {
    if (!live) return;
    let current = true;
    reads.modules.website.publishedUrl(node.id).then(
      (r) => { if (current) setServed({ id: node.id, path: r.published_url }); },
      () => {/* no link offered; the other buttons still work */},
    );
    return () => { current = false; };
  }, [live, node.id, statusKey]);
  const servedPath = served?.id === node.id ? served.path : null;
  const publishUrl = live && servedPath ? `${pageOrigin()}${servedPath}` : null;

  if (readOnly || blocked) return null;

  const confirmPublish = async (): Promise<boolean> => {
    if (!(await review.confirm())) return false; // reported; a stale preview shows the new one
    setPublishes((n) => n + 1);
    return true;
  };
  const keepOnlyThis = () => { setAsking(false); runBackgroundWrite(propertyWriter.set(node.id, PUBLISHED_ATTR, "false", PUBLISHED_FLAG)); };
  const keepOff = () => { if (below > 0) setAsking(true); else keepOnlyThis(); };
  // The answer decides whether the dialog closes: a refused or unsent action keeps the question (the write reports why).
  const keepWithBelow = async () => {
    setWorking(true);
    try { await writer.keepSubtreeOff(node.id); setAsking(false); } catch { /* reported by the online write */ } finally { setWorking(false); }
  };
  const publishSite = () => void review.start(async () => homePublishBody(siteSettingsFromConfig(getAppState().data.site_config)));
  const copyLink = () => {
    if (!publishUrl) return;
    void copyText(publishUrl, { what: "url", successToast: false }).then((ok) => { if (ok) flashCopied(); });
  };

  const statusText = !standing.on
    ? standing.reason === "kept_off" ? t("Kept off the site")
      : standing.reason === "kept_off_by_parent" ? t("Off the site by default: the note above it was kept off when this one was made")
      : standing.reason === "blank" ? t("Blank notes are not put on the site")
      : t("Articles saved from feeds are not put on the site")
    : siteState === "current" ? t("On the site")
    : siteState === "outdated" ? t("The site has an older version")
    : siteState === "not_on_site" ? t("Goes live with the next site publish")
    : t("Goes on the site");
  const canPublishSite = isOwner && online && !review.loading && !review.publishing;
  const action = "info-function-run tap-target";

  return (
    <div className="info-publish">
      <Globe size={16} aria-hidden="true" className="info-function-icon" />
      <div className="info-publish-body">
        <span className="info-function-text" role="status">{statusText}</span>
        {!standing.on && below > 0 && <span className="info-function-text">{t("{n} notes under it are still on the site", { n: below })}</span>}
        {!onSite && (standing.reason === "kept_off" || standing.reason === "kept_off_by_parent") && (
          <span className="info-function-text">{t("Putting it back returns it to the site with your next publish.")}</span>
        )}
        {asking && (
          <div className="publish-left-out-confirm" role="group" aria-label={t("Notes under this one")}>
            <p>{t("Keep the {n} notes under it off the site too?", { n: below })}</p>
            <div className="publish-left-out-actions">
              <Button variant="primary" disabled={working} data-action="keep-off-with-below" onClick={() => void keepWithBelow()}>{working ? "…" : t("Keep them all off")}</Button>
              <Button variant="ghost" disabled={working} data-action="keep-off-only-this" onClick={keepOnlyThis}>{t("Only this one")}</Button>
              <Button variant="ghost" disabled={working} onClick={() => setAsking(false)}>{t("Cancel")}</Button>
            </div>
          </div>
        )}
        <div className="info-publish-actions">
          {onSite && siteState === "not_on_site" && isOwner && online && (
            <Pressable type="button" className={action} data-action="publish-site" disabled={!canPublishSite} onClick={publishSite}>{review.loading ? "…" : t("Publish now")}</Pressable>
          )}
          {onSite && siteState === "outdated" && isOwner && online && (
            <Pressable type="button" className={action} data-action="publish-site" disabled={!canPublishSite} onClick={publishSite}>{review.loading ? "…" : t("Update")}</Pressable>
          )}
          {publishUrl && <Pressable type="button" className={action} data-action="copy-link" onClick={copyLink}>{copied ? t("Copied") : t("Copy link")}</Pressable>}
          {publishUrl && <Link className={action} data-action="open-page" href={publishUrl} target="_blank" rel="noreferrer">{t("Open page")}</Link>}
          {onSite && <Pressable type="button" className={action} data-action="unpublish" onClick={keepOff}>{t("Keep off the site")}</Pressable>}
          {!onSite && (
            <Pressable type="button" className={action} data-action="put-back" onClick={() => putOnSite(node)}>
              {standing.reason === "kept_off" || standing.reason === "kept_off_by_parent" ? t("Put back on the site") : t("Publish anyway")}
            </Pressable>
          )}
        </div>
      </div>
      {review.pending && (
        <PublishPreviewDialog pending={review.pending} publishing={review.publishing} online={online}
          onConfirm={confirmPublish} onCancel={review.cancel} onChanged={() => void review.refresh()} />
      )}
    </div>
  );
}
