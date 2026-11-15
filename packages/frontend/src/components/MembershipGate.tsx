import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { WriteActionError, writeErrors } from "../lib/data";
import { register } from "../lib/liveInvalidation";
import { isPageHidden } from "../lib/documentAccess";
import { Pressable, layerClass } from "./ui";

/** The sync layer alone releases the gate. Retrying a failed check must remain
 * possible while the workspace below is inert, including when the queue is empty. */
export default function MembershipGate({ onRetry }: { onRetry: () => Promise<{ ok: boolean }> }) {
  const t = useT();
  const retryRef = useRef<(() => void) | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let delay = 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms = delay) => {
      clearTimeout(timer);
      if (!disposed && !isPageHidden()) timer = setTimeout(() => void retry(false), ms);
    };
    async function retry(manual: boolean) {
      if (disposed || busy) return;
      clearTimeout(timer);
      if (manual) delay = 5000;
      busy = true; setWorking(true); setError(null);
      try {
        const result = await onRetry();
        if (disposed) return;
        if (!result.ok) throw new WriteActionError(t("Sync could not finish. Check your connection and try again."));
      } catch (cause) {
        if (!disposed) writeErrors.report(cause, setError);
      } finally {
        busy = false;
        if (!disposed) {
          setWorking(false);
          schedule();
          delay = Math.min(delay * 2, 30_000);
        }
      }
    }
    retryRef.current = () => void retry(true);
    setWorking(false); setError(null);
    // The initial check is already running. Reuse it if still pending; only
    // sync can release the gate. Even an ok pass can be followed by a dirty
    // recheck; if the gate stays mounted, keep retrying with bounded backoff.
    schedule();
    // A hidden tab stops retrying (schedule); coming back retries at once.
    const unregisterVisible = register("visible", () => { if (!busy) schedule(0); });
    return () => {
      disposed = true;
      clearTimeout(timer);
      retryRef.current = null;
      unregisterVisible();
    };
  }, [onRetry, t]);
  return <div className={`${layerClass.fixed} membership-gate`}>
    <div className="membership-gate-card">
      <div className="app-boot-spinner" aria-hidden="true" />
      <span role="status">{t("Checking your workspace…")}</span>
      <Pressable type="button" onClick={() => retryRef.current?.()} disabled={working}>{t("Check again")}</Pressable>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
