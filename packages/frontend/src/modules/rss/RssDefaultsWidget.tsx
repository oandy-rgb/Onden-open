import { useState } from "react";
import { useAppSelector } from "../../lib/appStore";
import { useIsOwner } from "../../lib/capabilities";
import { workspaceWriter, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { Button } from "../../components/ui";
import type { SettingContext } from "../../lib/settingsTypes";
import RssDestinationFields from "./RssDestinationFields";
import type { RssDestination } from "./useRssUnread";

// Settings › Modules › RSS — 「預設存到」, the workspace default for where a
// saved article goes when its feed has no default of its own. Stored like the
// other workspace settings: keys `rss_default_tags` (comma-separated tag ids)
// and `rss_default_parent` (a note id) in the workspace config (the Site Config
// note's attributes), written by the owner through PATCH /api/workspace/config
// (workspaceWriter.saveDesign). The backend reads them in
// modules/rss/destination.ts; a parent that is not a note is ignored there.

const TAGS_KEY = "rss_default_tags";
const PARENT_KEY = "rss_default_parent";

function stored(config: Record<string, unknown> | undefined): RssDestination {
  const tags = typeof config?.[TAGS_KEY] === "string" ? (config[TAGS_KEY] as string) : "";
  const parent = typeof config?.[PARENT_KEY] === "string" ? (config[PARENT_KEY] as string) : "";
  return { tagIds: tags.split(",").map((s) => s.trim()).filter(Boolean), parentId: parent || null };
}

export default function RssDefaultsWidget({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useIsOwner();
  const config = useAppSelector((s) => s.data.site_config);
  const [dest, setDest] = useState<RssDestination>(() => stored(config));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function save(next: RssDestination) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await workspaceWriter.saveDesign({ config: { [TAGS_KEY]: next.tagIds.join(","), [PARENT_KEY]: next.parentId ?? "" } });
      setDest(next);
      setStatus(result.status === "queued" ? writeErrors.queuedMessage() : t("Saved."));
    } catch {
      // The writer reported it.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rss-defaults-setting">
      <p className="settings-hint">{t("Where a saved article goes when its feed has no default of its own. Each feed can override it in its settings (⋯ beside the feed).")}</p>
      <RssDestinationFields value={dest} onChange={setDest} disabled={busy || !isOwner} />
      <div className="settings-row settings-row--actions">
        <Button type="button" variant="secondary" disabled={busy || !isOwner || !ctx.online}
          onClick={() => void save({ tagIds: [], parentId: null })}>
          {t("Clear")}
        </Button>
        <Button type="button" variant="primary" disabled={busy || !isOwner || !ctx.online} onClick={() => void save(dest)}>
          {busy ? t("Saving…") : t("Save default")}
        </Button>
      </div>
      {!isOwner && <p className="settings-hint">{t("Only the workspace owner can change this.")}</p>}
      {status && <p className="settings-hint" role="status">{status}</p>}
    </div>
  );
}
