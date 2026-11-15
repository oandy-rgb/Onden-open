// The notes the site leaves out, said in the publish dialog. Notes marked
// 「發布」 that cannot go on come with the way out: move them to a space that
// publishes (after the owner confirms who gains access), or open the space's
// settings. Notes a publishing space keeps off (their own 「不發布」, blank, saved
// from a feed) are listed folded, so the owner can check nothing is missing.
// The reason comes from the server's preview (backend LeftOutNote), not from
// this device's guess.
import { Button } from "../../components/ui";
import { putOnSite } from "./putOnSite";
import { PUBLISHED_ATTR } from "./publishBlocker";
import { useT } from "../../lib/i18n";
import { openSpacesAndMembers } from "../../lib/settingsRequest";
import { spaceLabel } from "../../lib/spaces";
import PublishMoveConfirm from "./PublishMoveConfirm";
import { usePublishMove } from "./usePublishMove";
import { displayTitle } from "../../lib/noteLabel";
import type { LeftOutNote } from "@onden/contract";

export default function PublishLeftOut({ items, online, busy, onChanged, onClose }: {
  items: LeftOutNote[];
  online: boolean;
  busy: boolean;
  /** Something moved: the preview must be built again. */
  onChanged: () => void;
  /** The dialog closes before the settings open on top of it. */
  onClose: () => void;
}) {
  const t = useT();
  const marked = items.filter((n) => n.reason === "hidden" || n.reason === "space_not_published");
  const keptOff = items.filter((n) => n.reason !== "hidden" && n.reason !== "space_not_published");
  const inClosedSpace = items.filter((n) => n.reason === "space_not_published" && n.space);
  const closedShared = [...new Map(inClosedSpace.filter((n) => n.space!.kind === "shared").map((n) => [n.space!.id, n.space!])).values()];
  const mover = usePublishMove(inClosedSpace.map((n) => ({ nodeId: n.node_id, fromSpaceId: n.space!.id })), online, onChanged);
  const label = (space: NonNullable<LeftOutNote["space"]>) => spaceLabel(space);

  const why = (reason: LeftOutNote["reason"]) => reason === "kept_off" ? t("set to stay off the site")
    : reason === "kept_off_by_parent" ? t("made under a note kept off the site, so it starts off too")
    : reason === "blank" ? t("blank note") : reason === "saved_article" ? t("saved from a feed") : t("left off the site");

  return (
    <>
    {keptOff.length > 0 && (
      <details className="publish-left-out-kept">
        <summary>{t("{n} notes in publishing spaces stay off the site", { n: keptOff.length })}</summary>
        <p className="publish-review-hint">{t("Blank notes and articles saved from feeds stay off unless you publish them; a note set to stay off is your choice.")}</p>
        <ul className="publish-review-list">
          {keptOff.map((n) => <li key={n.node_id}>{displayTitle(n.title)}<span className="publish-review-note"> · {why(n.reason)}</span>
            {n.reason === "kept_off_by_parent" && (
              <Button variant="ghost" data-action="put-back" disabled={!online || busy}
                onClick={() => void Promise.resolve(putOnSite({ id: n.node_id, attrs: { [PUBLISHED_ATTR]: "false" } })).then(onChanged)}>{t("Put back on the site")}</Button>
            )}
          </li>)}
        </ul>
      </details>
    )}
    {marked.length > 0 && (
    <section className="publish-review-warn publish-left-out">
      <h3>{t("Marked for the site but left out ({n})", { n: marked.length })}</h3>
      <p className="publish-review-hint">{t("These notes will not be on the site, so readers will not see them.")}</p>
      <ul className="publish-review-list">
        {marked.map((n) => (
          <li key={n.node_id}>
            {displayTitle(n.title)}
            <span className="publish-review-note"> · {n.reason === "hidden"
              ? t("it is hidden, and hidden notes are not published")
              : n.space ? t("it is in “{space}”, which does not publish", { space: label(n.space) })
              : t("its space does not publish")}</span>
          </li>
        ))}
      </ul>
      {inClosedSpace.length > 0 && !mover.gain && (
        <div className="publish-left-out-actions">
          {mover.destination && (
            <Button disabled={!online || busy || mover.working} onClick={() => void mover.ask()}>
              {t("Move to “{space}”", { space: mover.destinationName })}
            </Button>
          )}
          {closedShared.map((space) => (
            <Button key={space.id} variant="ghost" onClick={() => { onClose(); openSpacesAndMembers(space.id); }}>
              {t("Turn on publishing for “{space}”", { space: label(space) })}
            </Button>
          ))}
        </div>
      )}
      {mover.gain && <PublishMoveConfirm count={inClosedSpace.length} mover={mover} />}
    </section>
    )}
    </>
  );
}
