// One recovery surface for unconfirmed input and queued changes the server
// rejected. Only unconfirmed input can be requeued here; a known refusal needs
// a user's new decision, not another automatic attempt at the same operation.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { copyText } from "../lib/clipboard";
import { X } from "lucide-react";
import { addToast, getNode } from "../lib/appStore";
import { clampNoteTitle } from "@onden/markdown";
import { targetIds } from "../lib/pendingWriteTargets";
import { untitledTitle } from "../lib/noteLabel";
import { noteWriter, writeErrors } from "../lib/data";
// Direct import: through the index Rollup warns of a cross-chunk cycle (lib/data/index.ts re-exports sync.ts).
// eslint-disable-next-line onden/module-entry
import { dataSync, recovery } from "../lib/data/sync";
import type { OfflineQueueFailedDetail, LostWrite } from "../lib/data";
import { useT } from "../lib/i18n";
import { randomUUID } from "../lib/uuid";
import "./FailedWriteRecovery.css";
import { Button, Pressable, TopLayerPortal, layerClass } from "./ui";
import { onWindow } from "../lib/globalEvents";

export default function FailedWriteRecovery() {
  const t = useT();
  const lost = useSyncExternalStore(recovery.subscribe, recovery.list, recovery.list);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    void recovery.refresh().catch(error => writeErrors.report(error, addToast));
    function onFailed(event: Event) {
      const detail = (event as CustomEvent<OfflineQueueFailedDetail>).detail;
      if (detail) recovery.remember(detail);
    }
    return onWindow(dataSync.QUEUE_FAILED_EVENT, onFailed);
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusy(current => new Set(current).add(id));
    try { await recovery.remove(id); }
    catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(current => { const next = new Set(current); next.delete(id); return next; }); }
  }, []);

  const retry = useCallback(async (w: LostWrite) => {
    // Keep the recovery mirror during the asynchronous IndexedDB commit so a
    // reload while retrying cannot erase the only durable copy.
    const key = w.idemKey ?? randomUUID();
    if (!w.idemKey) recovery.setKey(w.id, key);
    if (!await recovery.requeue(w.method, w.path, w.body, key)) return;
    await remove(w.id);
    // Queued is not sent: send it now, or the text would wait for the next sync round with the entry already gone.
    await dataSync.flushQueue().catch(error => writeErrors.report(error, addToast));
  }, [remove]);

  // The note a refused save was meant for was deleted elsewhere: its text can still become a note of its own.
  const keepAsNewNote = useCallback(async (w: LostWrite) => {
    if (!w.noteText) return;
    const firstLine = w.noteText.markdown.trim().split("\n", 1)[0]!.trim();
    const title = clampNoteTitle((w.noteText.title ?? "").trim() || firstLine) || untitledTitle();
    try { await noteWriter.create({ title, markdown: w.noteText.markdown }); }
    catch { return; } // the writer reported why; the entry stays
    await remove(w.id);
  }, [remove]);

  const copy = useCallback((w: LostWrite) => copyText(w.text), []);

  if (lost.length === 0) return null;

  if (collapsed) return (
    <TopLayerPortal>
      <div className={`${layerClass.fixed} failed-write-recovery fwr-collapsed`}>
        <Button type="button" variant="secondary" onClick={() => setCollapsed(false)}>
          {t("Recovery inputs ({n})", { n: lost.length })}
        </Button>
      </div>
    </TopLayerPortal>
  );

  return (
    <TopLayerPortal>
      <div className={`${layerClass.fixed} failed-write-recovery`} role="alert" aria-live="assertive">
        <Button type="button" variant="secondary" className="fwr-collapse" onClick={() => setCollapsed(true)}>
          {t("Minimize recovery panel")}
        </Button>
        {lost.map((w) => (
          <div key={w.id} className="fwr-card">
            <div className="fwr-head">
              <span className="fwr-title">{t(w.rejection ? "This change was rejected" : "This change couldn't be saved")}</span>
              <Pressable
                type="button"
                className="fwr-dismiss"
                onClick={() => void remove(w.id)}
                disabled={busy.has(w.id)}
                aria-label={t(w.rejection ? "Remove recovery copy" : "Dismiss")}
                title={t(w.rejection ? "Remove recovery copy" : "Dismiss")}
              >
                <X size={14} />
              </Pressable>
            </div>
            <p className="fwr-note">{t(w.unpersisted
              ? "Recovery storage is not confirmed. Copy this input before leaving; it will not be sent again automatically."
              : w.rejection && !w.text
              ? "Nothing you typed is in this change. Remove it when you no longer need it."
              : w.rejection
              ? "Your input is saved on this device and will not be sent again automatically. Copy it before removing this recovery copy."
              : "It wasn't queued and may be lost. Your text is below — try again or copy it somewhere safe.")}</p>
            {w.rejection && <p className="fwr-note">{w.rejection}</p>}
            {w.text && <pre className="fwr-content">{w.text}</pre>}
            <div className="fwr-actions">
              {!w.rejection && <Button type="button" variant="primary" onClick={() => void retry(w)}>
                {t("Try again")}
              </Button>}
              {w.rejection && w.noteText && targetIds(w, "node").some((id) => !getNode(id)) && (
                <Button type="button" variant="primary" disabled={busy.has(w.id)} onClick={() => void keepAsNewNote(w)}>
                  {t("Keep as a new note")}
                </Button>
              )}
              {w.text && <Button type="button" variant="secondary" onClick={() => void copy(w)}>
                {t("Copy to clipboard")}
              </Button>}
            </div>
          </div>
        ))}
      </div>
    </TopLayerPortal>
  );
}
