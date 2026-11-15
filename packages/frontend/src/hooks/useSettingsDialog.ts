import { useEffect, useState } from "react";
import { addToast, getAppState } from "../lib/appStore";
import { t } from "../lib/i18n";
import { mergeLocalNodesToServer } from "../lib/serverMerge";
import { onSettingsRequest } from "../lib/settingsRequest";
import { resolveSettingsTab, type SettingsTab } from "../lib/settingsTab";
import { useStableCallback } from "./useStableCallback";

/**
 * The settings dialog: open at a tab (topbar, mobile nav, or a request from
 * anywhere via lib/settingsRequest), and the "connect to a server" follow-up.
 */
export function useSettingsDialog({ sync, refresh }: { sync: () => Promise<unknown>; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab | undefined>(undefined);
  const openSettings = useStableCallback(() => { setTab(undefined); setOpen(true); });
  const closeSettings = useStableCallback(() => { setOpen(false); setTab(undefined); });
  // Settings at a given tab, asked for from outside the shell (lib/settingsRequest).
  useEffect(() => onSettingsRequest((requested) => { setTab(resolveSettingsTab(requested) ?? undefined); setOpen(true); }), []);
  // The user just pointed the app at a (new) server. Drain the queued offline
  // writes first (sync), then create any notes the server is missing
  // (lib/serverMerge — it never overwrites existing server notes), and finally
  // pull the authoritative bootstrap. Per-node failures surface as one
  // summary toast.
  const connected = useStableCallback(() => {
    const localNodes = getAppState().data.nodes;
    void (async () => {
      await sync();
      try {
        const { failed } = await mergeLocalNodesToServer(localNodes);
        if (failed > 0) addToast(t("{n} notes could not be pushed to the server", { n: failed }), "error");
      } catch { /* still offline — bootstrap unreachable; nothing to merge against */ }
      await refresh();
    })();
  });
  return { open, tab, openSettings, closeSettings, connected };
}
