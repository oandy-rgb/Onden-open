import { useState } from "react";
import { useAppSelector } from "../../lib/appStore";
import { canWriteSpace, useIsOwner } from "../../lib/capabilities";
import { reads, workspaceWriter, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { spaceLabel, useSpaces, type Space } from "../../lib/spaces";
import { confirmDialog } from "../../components/ConfirmDialog";
import type { SettingContext } from "../../lib/settingsTypes";
import { Select } from "../../components/ui";

// Settings › Modules › RSS — 「訂閱放在」, the space new subscriptions go to
// (and where the owner's existing ones move). Workspace config key
// `rss_source_space` (a space id; "" = each person's own 只有我), changed only
// through PUT /api/rss/source-space so the setting and the move commit
// together (backend modules/rss/sourceSpace.ts). The owner picks; everyone
// else sees the current value read-only.

const KEY = "rss_source_space";

export default function RssSourceSpaceWidget({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useIsOwner();
  const stored = useAppSelector((s) => {
    const value = (s.data.site_config as Record<string, unknown> | undefined)?.[KEY];
    return typeof value === "string" ? value : "";
  });
  const { spaces } = useSpaces(ctx.online);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Shared spaces the owner can write in: the owner manages every shared space.
  const choices = spaces.filter((space) => space.kind === "shared" && canWriteSpace(space));
  const current = spaces.find((space) => space.id === stored);

  async function choose(next: string) {
    if (next === stored) return;
    setStatus(null);
    setError(null);
    setBusy(true);
    try {
      if (!next) {
        // Nothing moves back: the setting only decides where new ones go.
        const ok = await confirmDialog(
          t("Switch back to Only me? Subscriptions already in the shared space stay there, and everyone in that space can still see them. Only new subscriptions will be kept private."),
          { confirmLabel: t("Switch back") });
        if (!ok) return;
      } else {
        const target = choices.find((space) => space.id === next)!;
        const { movable, skipped_duplicate: skipped } = await reads.people.rssSourceSpacePreview(next);
        if (movable > 0 || skipped > 0) {
          const skipNote = skipped > 0
            ? " " + t("{count} subscriptions are already followed in that space, so they are skipped and stay where they are.", { count: skipped })
            : "";
          const ok = await confirmDialog(
            movable > 0
              ? t("Move {count} of your subscriptions to “{space}”? Articles you already saved stay where they are. Other people's subscriptions stay where they are. People in this space will see all of it, and switching back to Only me later will not move it back.", { count: movable, space: spaceLabel(target) }) + skipNote
              : t("No subscription of yours needs to move to “{space}”.", { space: spaceLabel(target) }) + skipNote,
            { confirmLabel: t("Move") });
          if (!ok) return;
        }
      }
      const { moved, skippedDuplicate } = await workspaceWriter.setRssSourceSpace(next, ctx.online);
      const saved = moved > 0 ? t("Saved. {count} subscriptions moved.", { count: moved }) : t("Saved.");
      setStatus(skippedDuplicate > 0
        ? saved + " " + t("{count} subscriptions are already followed in that space, so they are skipped and stay where they are.", { count: skippedDuplicate })
        : saved);
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      setBusy(false);
    }
  }

  const label = (space: Space) => spaceLabel(space);
  return (
    <div className="rss-source-space-setting">
      <label className="settings-row-title" htmlFor="rss-source-space">{t("Keep subscriptions in")}</label>
      <Select id="rss-source-space" value={stored} disabled={busy || !isOwner || !ctx.online}
        onChange={(e) => void choose(e.target.value)}>
        <option value="">{t("Only me")}</option>
        {choices.map((space) => <option key={space.id} value={space.id}>{label(space)}</option>)}
        {stored && !choices.some((space) => space.id === stored) && (
          <option value={stored}>{current ? label(current) : t("A shared space")}</option>
        )}
      </Select>
      <p className="settings-hint">{t("Everyone in this space can see these subscriptions and their articles.")}</p>
      {!isOwner && <p className="settings-hint">{t("Only the workspace owner can change this.")}</p>}
      {status && <p className="settings-hint" role="status">{status}</p>}
      {error && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
