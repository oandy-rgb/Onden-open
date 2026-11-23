// What Publish → shows before anything goes out (W38b): the candidate built by
// the same code a publish stores — what changes against the last publish, the
// links readers will see as "(private)", media they won't get — and the site
// itself as it will look. Confirming publishes that candidate by its hash.
import { Suspense, useState } from "react";
import ShellDialog from "../../components/ShellDialog";
import { Button } from "../../components/ui";
import { getNode, hasChildNote, useAllNodes } from "../../lib/appStore";
import { listsAsNote } from "../../lib/nodeTags";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useT } from "../../lib/i18n";
import { useSpaces } from "../../lib/spaces";
import { dateLabel } from "../../lib/timeLabels";
import PublishLeftOut from "./PublishLeftOut";
import { previewHasChanges, type PendingPublish } from "./publishPreview";
import { blockedNotes } from "./studio/editorData";
import { PUBLISHED_ATTR, siteStanding } from "./publishBlocker";
import { useHintOnce } from "../../hooks/useHintOnce";
import { displayTitle } from "../../lib/noteLabel";
import "./PublishPreviewDialog.css";
import EmptyState from "../../components/EmptyState";
import type { LeftOutNote, PreviewNote } from "@onden/contract";

// The home page of the candidate is drawn by the studio's components (the same
// ones as the site) and their stylesheet: loaded when the owner asks to see
// the site, not with the app.
const PublishedHomePreview = lazyWithReload(() => import("./studio/PublishedHomePreview"));

type CandidateNode = { id: string; title?: string };

export default function PublishPreviewDialog({ pending, publishing, online, onConfirm, onCancel, onInclude, onChanged }: {
  pending: PendingPublish;
  publishing: boolean;
  online: boolean;
  /** Resolves true when the site went out (the one-time rule hint is then marked seen, not before). */
  onConfirm: () => void | Promise<boolean>;
  onCancel: () => void;
  /** 「一起發布」: publish these notes together with the site. Omitted: the button is not offered. */
  onInclude?: (noteIds: string[]) => void;
  /** The owner moved notes from this dialog: build the preview again. Omitted: the preview is not rebuilt. */
  onChanged?: () => void;
}) {
  const t = useT();
  const [showSite, setShowSite] = useState(false);
  const { preview } = pending;
  const { diff } = preview;
  const nodes = (preview.site.payload.nodes ?? []) as CandidateNode[];
  const allNodes = useAllNodes();
  const { spaces } = useSpaces(online);
  // Notes marked for the site that the site leaves out, and why: the server's
  // answer. An older server sends none; this device's own reading stands in.
  const leftOut: LeftOutNote[] = preview.left_out ?? blockedNotes(allNodes, spaces).filter((n) => n.marked).map((n) => {
    const space = spaces.find((sp) => sp.id === allNodes.find((x) => x.id === n.id)?.space_id);
    return {
      node_id: n.id, title: n.title, reason: n.blocker.reason === "hidden" ? "hidden" as const : "space_not_published" as const,
      space: space && space.kind !== "system" ? { id: space.id, kind: space.kind, is_default: space.is_default, name: space.name } : null,
    };
  });
  // Since publishing went by space, a note joins the site by its space, not by being marked: the first publish that adds
  // notes nobody marked says so once (the account's "seen" list, so a second device does not repeat it).
  const ruleHint = useHintOnce("publish-by-space-rule");
  const showRuleHint = ruleHint.show && diff.added.some((n) => getNode(n.id)?.attrs?.[PUBLISHED_ATTR] !== "true");
  // Seen only once the publish went out: after a stale preview or a network failure the next preview says it again.
  // After a publish that did not go out the same button says so: the dialog stays open and pressing it again is the retry.
  const [failedOnce, setFailedOnce] = useState(false);
  const confirm = async () => {
    const sent = (await onConfirm()) === true;
    setFailedOnce(!sent);
    if (sent && showRuleHint) ruleHint.markSeen();
  };
  const noneOnSite = !allNodes.some((n) => listsAsNote(n) && siteStanding(n, spaces, hasChildNote(n.id)).on);
  const refs = preview.unpublished_refs ?? [];
  const hasStanding = refs.length > 0 || leftOut.length > 0 || preview.private_links.length > 0 || preview.blocked_media.length > 0;
  const titleOf = (id: string) => displayTitle(nodes.find((n) => n.id === id)?.title);
  const list = (items: PreviewNote[], extra?: (n: PreviewNote) => string | null) => (
    <ul className="publish-review-list publish-preview-list">
      {items.map((n) => (
        <li key={n.id}>
          <span className="publish-review-slug">/{n.slug}</span> {displayTitle(n.title)}
          {extra?.(n) && <span className="publish-review-note"> · {extra(n)}</span>}
        </li>
      ))}
    </ul>
  );

  if (showSite) {
    return (
      <ShellDialog label={t("The site as it will publish")} className="publish-review publish-review-site" busy={publishing} onClose={() => setShowSite(false)}>
        <div className="publish-review-site-bar">
          <Button onClick={() => setShowSite(false)}>{t("Back")}</Button>
          <span>{t("The site as it will publish")}</span>
        </div>
        <div className="publish-review-site-frame">
          <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
            <PublishedHomePreview site={preview.site} />
          </Suspense>
        </div>
      </ShellDialog>
    );
  }

  return (
    <ShellDialog label={t("Publish the site")} className="publish-review publish-preview-dialog" busy={publishing} onClose={onCancel}>
      <div className="publish-review-body">
      <h2 className="publish-review-title">{t("Publish the site")}</h2>
      <p className="publish-review-hint">
        {preview.live
          ? t("Compared with the last publish, {date}.", { date: dateLabel(preview.live.published_at, "dateTime") })
          : t("This is the first publish.")}
      </p>

      {nodes.length === 0 ? (
        <p className="publish-review-empty">
          {leftOut.length > 0
            ? t("Publishing now would produce an empty site: every note that could go on it is left out (see below).")
            : noneOnSite
              ? t("Publishing now would produce an empty site. No space publishes yet: turn on “Publish to the website” for a space in Settings › Spaces and members.")
              : t("Publishing now would produce an empty site. The notes have not reached the server yet; wait for them to sync, then try again.")}
        </p>
      ) : !previewHasChanges(preview) ? (
        <p className="publish-review-hint">{t("Nothing has changed since the last publish.")}</p>
      ) : (
        <>
          {showRuleHint && (
            <section className="publish-review-warn">
              <p>{t("Every note in a space that publishes goes on the site. To keep a note off, mark it “Don't publish”.")}</p>
            </section>
          )}
          {diff.added.length > 0 && (
            <section>
              <h3>{t("New on the site ({n})", { n: diff.added.length })}</h3>
              {list(diff.added)}
            </section>
          )}
          {(diff.returning?.length ?? 0) > 0 && (
            <section>
              <h3>{t("Coming back to the site ({n})", { n: diff.returning!.length })}</h3>
              <p className="publish-review-hint">{t("These were taken off the site earlier. They return only with this publish, with their text as it is now.")}</p>
              {list(diff.returning!)}
            </section>
          )}
          {diff.changed.length > 0 && (
            <section>
              <h3>{t("Changed ({n})", { n: diff.changed.length })}</h3>
              {list(diff.changed)}
            </section>
          )}
          {diff.moved.length > 0 && (
            <section>
              <h3>{t("Moved ({n})", { n: diff.moved.length })}</h3>
              {list(diff.moved)}
            </section>
          )}
          {diff.links_changed.length > 0 && (
            <section>
              <h3>{t("Links changed ({n})", { n: diff.links_changed.length })}</h3>
              {list(diff.links_changed)}
            </section>
          )}
          {diff.removed.length > 0 && (
            <section>
              <h3>{t("Leaving the site ({n})", { n: diff.removed.length })}</h3>
              {list(diff.removed, (n) => (diff.removed.find((r) => r.id === n.id)?.taken_down ? t("already hidden from readers") : null))}
            </section>
          )}
          {diff.settings_changed && <p className="publish-review-hint">{t("The site's name, home page or design changed.")}</p>}
        </>
      )}

      {(preview.new_media ?? []).length > 0 && (
        <section>
          <h3>{t("Newly public files ({n})", { n: preview.new_media!.length })}</h3>
          <ul className="publish-review-list">
            {preview.new_media!.map((m) => (
              <li key={m.filename}>
                {m.used_as === "logo" ? t("The site logo")
                  : m.used_as === "favicon" ? t("The site icon")
                    : m.node_ids.length > 0 ? t("Image in {notes}", { notes: m.node_ids.map(titleOf).join("、") })
                      : t("Image in the home page design")}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(preview.large_videos ?? []).length > 0 && (
        <section className="publish-review-warn">
          <h3>{t("Videos too large for the copy ({n})", { n: preview.large_videos!.length })}</h3>
          <p className="publish-review-note">{t("On a copy hosted elsewhere they become a link back here.")}</p>
          <ul className="publish-review-list">
            {preview.large_videos!.map((v) => (
              <li key={v.filename}>
                {t("{name} ({size} MB)", { name: v.node_ids.length > 0 ? v.node_ids.map(titleOf).join("、") : t("Video"), size: v.size_mb })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasStanding && (
        <div className="publish-review-standing" role="group" aria-labelledby="publish-review-standing-title">
          <h3 id="publish-review-standing-title" className="publish-review-group">{t("What readers will and won't see")}</h3>
          <p className="publish-review-hint">
            {previewHasChanges(preview)
              ? t("This is about the site as it stands, apart from the changes above.")
              : t("This is the same as last time. It is about what the site shows, not about this publish.")}
          </p>
      {refs.length > 0 && (
        <section className="publish-review-warn">
          <h3>{t("On the home page but not published ({n})", { n: refs.length })}</h3>
          <p className="publish-review-hint">{t("Readers see nothing in these places unless the notes are published with the site.")}</p>
          <ul className="publish-review-list">
            {refs.map((ref) => <li key={`${ref.componentId}:${ref.noteId}`}>{displayTitle(ref.title)}</li>)}
          </ul>
          {onInclude && (
            <Button className="publish-preview-include" disabled={!online || publishing}
              onClick={() => onInclude([...new Set(refs.map((r) => r.noteId))])}>
              {t("Publish together")}
            </Button>
          )}
        </section>
      )}

      {leftOut.length > 0 && (
        <PublishLeftOut items={leftOut} online={online} busy={publishing}
          onChanged={() => onChanged?.()} onClose={onCancel} />
      )}

      {preview.private_links.length > 0 && (
        <section className="publish-review-warn">
          <h3>{t("Links to private notes ({n})", { n: preview.private_links.length })}</h3>
          <p className="publish-review-hint">{t("Readers see the text below instead of a link; the private note stays private.")}</p>
          <ul className="publish-review-list">
            {preview.private_links.map((l, i) => (
              <li key={i}>{t("In “{note}”: [[{target}]] reads “{shown}”", { note: displayTitle(l.node_title), target: l.target, shown: l.shown_as === "(private)" ? t("(private)") : l.shown_as })}</li>
            ))}
          </ul>
        </section>
      )}

      {preview.blocked_media.length > 0 && (
        <section className="publish-review-warn">
          <h3>{t("Images readers won't see ({n})", { n: preview.blocked_media.length })}</h3>
          <ul className="publish-review-list">
            {preview.blocked_media.map((m) => (
              <li key={m.filename}>
                {m.reason === "missing"
                  ? t("{file}: the file is missing on the server", { file: m.filename })
                  : t("{file}: it belongs to a private note", { file: m.filename })}
                {m.node_ids.length > 0 && <span className="publish-review-note"> · {m.node_ids.map(titleOf).join("、")}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
        </div>
      )}

      </div>

      <div className="publish-review-actions">
        <Button onClick={() => setShowSite(true)} disabled={nodes.length === 0}>{t("See the site")}</Button>
        <span className="publish-review-spacer" />
        <Button variant="ghost" onClick={onCancel} disabled={publishing}>{t("Cancel")}</Button>
        <Button variant="primary" className="publish-preview-confirm" disabled={!online || publishing || nodes.length === 0} onClick={confirm}>
          {publishing ? t("Publishing…") : failedOnce ? t("Try publishing again →") : t("Confirm & publish →")}
        </Button>
      </div>
    </ShellDialog>
  );
}
