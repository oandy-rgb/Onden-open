import { useEffect, useState } from "react";
import { copyText } from "../lib/clipboard";
import { addToast, useAppSelector } from "../lib/appStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { useToasts } from "../hooks/useToasts";
import { reloadForNewBuild } from "../lib/buildVersion";
import { useProtocolBlock } from "../lib/protocolGate";
import { useLocalCopyUnavailable } from "../lib/localCopyStatus";
import { retryLocalCopySave } from "../lib/data";
import { useT } from "../lib/i18n";
import { takeReloadNotice, type ReloadVerdict } from "../lib/lazyWithReload";
import { useUnseenChanges } from "../hooks/useUnseenChanges";
import WhatsNewCard from "./WhatsNewCard";
import { displayTitle } from "../lib/noteLabel";
import "./DeviceNotices.css";
import { Button, Pressable, TopLayerPortal, layerClass, useTopModalLayer } from "./ui";

/** What is different about THIS device rather than the workspace: the offline
 *  copy is being replaced or is missing, or a newer version is out; and, once
 *  the new version is here, what changed in it (「這次更新」). One short
 *  line each, no ids or details. Saving is never blocked by these. */
export default function DeviceNotices() {
  const t = useT();
  const localCopy = useAppSelector((s) => s.localCopy);
  const newVersion = useAppSelector((s) => s.newVersionAvailable);
  const serverOld = useProtocolBlock() === "server_old";
  const copyUnsaved = useLocalCopyUnavailable();
  const { unseen, markAllSeen } = useUnseenChanges();
  const phone = useIsMobile();
  const dialogOpen = useTopModalLayer() !== null;
  const { toasts } = useToasts();
  const [reloading, setReloading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Success clears the notice through the worker's event; a repeated failure
  // leaves it as it is (the worker already tells the page only once).
  async function retrySave() {
    setRetrying(true);
    try { await retryLocalCopySave(); } catch { /* still full: the notice stays */ }
    finally { setRetrying(false); }
  }

  // The page reloaded while some notes' unsent text sat in recovery: say where.
  useEffect(() => {
    const kept = takeReloadNotice();
    if (kept > 0) addToast(t("{n} note(s) had changes that weren't saved. They are in the recovery panel.", { n: kept }), "info");
  }, [t]);

  function tellWhyNot(verdict: Exclude<ReloadVerdict, { kind: "safe" }>) {
    if (verdict.kind === "memory-only") {
      const titles = verdict.notes.map((note) => displayTitle(note.title));
      const text = verdict.notes.flatMap((note) => note.text ? [note.text] : []).join("\n\n");
      const message = titles.length === 1
        ? t("The changes to \"{title}\" aren't saved anywhere yet, so the page can't reload. Copy the text first.", { title: titles[0] })
        : t("The changes to {n} notes (\"{title}\" and others) aren't saved anywhere yet, so the page can't reload. Copy the text first.", { n: titles.length, title: titles[0] });
      addToast(message, "error", text ? { label: t("Copy text"), onClick: () => void copyText(text) } : undefined);
    } else if (verdict.kind === "local-queue") {
      addToast(t("{n} change(s) are still waiting on this device's local storage, so the page can't reload yet. Try again in a moment.", { n: verdict.waiting }), "error");
    } else if (verdict.kind === "typing") {
      addToast(t("The note changed just now, so the page didn't reload. Press reload again once it's saved."), "info");
    } else {
      addToast(t("Couldn't confirm your text is saved, so the page can't reload. Try again in a moment."), "error");
    }
  }

  async function reload() {
    setReloading(true);
    let verdict: ReloadVerdict;
    try { verdict = await reloadForNewBuild(); } catch { verdict = { kind: "unknown" }; }
    if (verdict.kind !== "safe") {
      setReloading(false);
      tellWhyNot(verdict);
    }
  }

  const deviceNotice = localCopy !== "ok" || newVersion || serverOld || copyUnsaved;
  // One notice at a time: 「這次更新」 is the least urgent, so it waits for the device
  // notices and toasts, and for a dialog / sheet / palette to close. It is NOT in the top
  // layer: whatever is open paints over it.
  const showWhatsNew = unseen.length > 0 && !deviceNotice && !dialogOpen && toasts.length === 0;
  const whatsNew = showWhatsNew && <div className={`${layerClass.fixed} device-notices device-notices--whats-new`}>
    <WhatsNewCard unseen={unseen} onSeen={markAllSeen} compact={phone} />
  </div>;
  if (!deviceNotice) return whatsNew || null;
  return <><TopLayerPortal><div className={`${layerClass.fixed} device-notices`} role="status">
    {localCopy === "restarting" && <p className="device-notice">{t("Local copy temporarily unavailable")}</p>}
    {localCopy === "none" && <p className="device-notice">{t("This device has no offline copy")}</p>}
    {copyUnsaved && <p className="device-notice device-notice--wide">
      {t("This device couldn't save its offline copy (its storage may be full), so recent changes may not be saved to this device yet. They sync again once you're back online. Free up space, then retry.")}
      {" "}<Pressable type="button" className="device-notice-retry" onClick={() => void retrySave()} disabled={retrying}>{t("Retry")}</Pressable>
    </p>}
    {serverOld && <p className="device-notice device-notice--wide">{t("The server needs an update. You are seeing this device's copy; your changes are kept here and will be sent once it is updated.")}</p>}
    {newVersion && <p className="device-notice device-notice--action">
      <Button type="button" onClick={() => void reload()} disabled={reloading}>{t("New version available — reload")}</Button>
    </p>}
  </div></TopLayerPortal>{whatsNew}</>;
}
