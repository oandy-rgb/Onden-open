import { useCallback, useEffect, useState } from "react";
import { reads } from "../../lib/data";
import { useT } from "../../lib/i18n";
import type { SettingContext } from "../../lib/settingsTypes";

// Settings › Modules › Semantic search — how many of your notes are ready to be
// found by meaning, in words a person reads ("12 of 40"). The server prepares
// them by itself (when the module is turned on and at each server start); this
// only shows how far it has got, counting the notes this reader can read.

const POLL_MS = 4000;

type Progress = { ready: number; total: number; working: boolean };

export default function SemanticIndexWidget({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = useCallback(async () => {
    try { setProgress(await reads.modules.semantic.status()); } catch { /* keep the last count */ }
  }, []);
  useEffect(() => {
    if (!ctx.online) return;
    void load();
    // Keeps counting while notes are being prepared.
    const timer = setInterval(() => { if (progress?.working) void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [ctx.online, load, progress?.working]);

  if (!ctx.online) return <p className="settings-hint">{t("Connect to see how many notes are ready.")}</p>;
  if (!progress) return null;
  return (
    <p className="settings-hint" role="status">
      {progress.total === 0
        ? t("You have no notes to prepare yet.")
        : progress.working
          ? t("Preparing your notes… {ready} of {total} are ready.", { ready: progress.ready, total: progress.total })
          : progress.ready >= progress.total
            ? t("All {total} notes are ready to be found by meaning.", { total: progress.total })
            : t("{ready} of {total} notes are ready to be found by meaning.", { ready: progress.ready, total: progress.total })}
    </p>
  );
}
