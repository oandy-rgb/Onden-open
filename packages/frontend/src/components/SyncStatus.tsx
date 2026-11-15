import { useRef, useState, useSyncExternalStore } from "react";
import { useAppSelector, addToast, useNode } from "../lib/appStore";
import { displayTitle } from "../lib/noteLabel";
import { usePendingWrites, usePendingStuck, usePendingRetry, useIncomingProblem, moveStuckWritesToRecovery, flushPendingWrites, WriteActionError, writeErrors, recovery } from "../lib/data";
import type { SendFailureReason } from "../lib/data";
import { useLocalCopyUnavailable } from "../lib/localCopyStatus";
import { useLocalOnlyStatus } from "../lib/localOnlyStatus";
import { agoLabel } from "../lib/timeLabels";
import { useT , tn } from "../lib/i18n";
import { classNames } from "../lib/utils";
import "./SyncStatus.css";
import { Pressable } from "./ui";

export type SyncAction = () => void | Promise<{ ok: boolean }>;

export type SyncTrouble = { kind: "offline" | "pending" | "error"; label: string };

/** What is wrong with saving right now, or null when nothing is: offline,
 * changes waiting to sync, or inputs the server refused (the recovery panel).
 * The phone top bar shows a badge only for these; "connected" is not news.
 * Same sources as SyncStatus and FailedWriteRecovery, so they cannot disagree. */
export function useSyncTrouble(): SyncTrouble | null {
  const t = useT();
  const pending = usePendingWrites();
  const online = useAppSelector(s => s.online);
  const refused = useSyncExternalStore(recovery.subscribe, recovery.list, recovery.list).length;
  const stuck = usePendingStuck();
  const retry = usePendingRetry();
  const incoming = useIncomingProblem();
  const copyUnavailable = useLocalCopyUnavailable();
  const localOnly = useLocalOnlyStatus();
  if (localOnly) return localOnly.trouble ? { kind: "error", label: localOnly.trouble } : null;
  if (stuck) return { kind: "error", label: stuckSummary(t, stuck) };
  if (copyUnavailable) return { kind: "error", label: t("This device's local copy cannot be saved") };
  if (!online) return { kind: "offline", label: pending > 0 ? tn("Offline — 1 change will sync on reconnect", "Offline — {n} changes will sync on reconnect", pending) : t("Offline — changes save locally") };
  if (refused > 0) return { kind: "error", label: t("Recovery inputs ({n})", { n: refused }) };
  if (pending > 0 && retry?.reason === "signin") return { kind: "error", label: tn("1 change can't sync until you sign in again", "{n} changes can't sync until you sign in again", pending) };
  if (pending > 0) return { kind: "pending", label: tn("1 change waiting to sync", "{n} changes waiting to sync", pending) };
  if (incoming) return { kind: "error", label: t(INCOMING_SENTENCES[incoming]) };
  return null;
}

const STUCK_REASONS: Record<SendFailureReason, string> = {
  server: "The server keeps answering with an error.",
  connection: "The connection is too unstable to send it.",
  signin: "You're signed out, so it can't be sent. Sign in again.",
  unknown: "It has been failing for a while.",
};

/** Still inside the retries, before the queue counts as stuck: calm, but says what failed last. */
const RETRY_SENTENCES: Record<SendFailureReason, string | null> = {
  server: "Still trying — your changes are safe on this device. The server answered with an error.",
  connection: "Still trying — your changes are safe on this device. The connection dropped.",
  signin: "Your changes are safe on this device. You're signed out — sign in again to send them.",
  unknown: null,
};

/** The other direction: the browser is online but the server's newest content is not arriving. */
const INCOMING_SENTENCES = {
  unreachable: "The server isn't responding, so changes from other devices haven't arrived. Yours are safe on this device.",
  refused: "The server couldn't send the latest changes. Yours are safe on this device.",
} as const;

function stuckSummary(t: ReturnType<typeof useT>, stuck: { count: number; oldestAt: number | null }): string {
  const ago = stuck.oldestAt === null ? "" : agoLabel(new Date(stuck.oldestAt).toISOString());
  return ago ? tn("1 change stuck, oldest {ago}", "{n} changes stuck, oldest {ago}", stuck.count, { ago }) : tn("1 change stuck", "{n} changes stuck", stuck.count);
}

/** Both layouts read the same durable queue. Connectivity and an empty queue
 * never certify that all drafts/rejected recovery inputs were saved. */
export default function SyncStatus({ onSyncNow, onOpenNote, expanded = false, disabled = false, inlineFeedback = false }: {
  onSyncNow?: SyncAction; onOpenNote?: (noteId: string) => void; expanded?: boolean; disabled?: boolean; inlineFeedback?: boolean;
}) {
  const t = useT();
  const pending = usePendingWrites();
  const stuck = usePendingStuck();
  const retry = usePendingRetry();
  const incoming = useIncomingProblem();
  const waitingNote = useNode(stuck?.noteId);
  const copyUnavailable = useLocalCopyUnavailable();
  const localOnly = useLocalOnlyStatus();
  const online = useAppSelector(s => s.online);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function syncNow() {
    if (busy.current || disabled || !online || !onSyncNow) return;
    busy.current = true; setWorking(true); setError(null);
    try {
      const result = await onSyncNow();
      if (result && !result.ok) throw new WriteActionError(t("Sync could not finish. Check your connection and try again."));
    } catch (cause) { writeErrors.report(cause, inlineFeedback ? message => setError(message) : addToast); }
    finally { busy.current = false; setWorking(false); }
  }
  async function moveToRecovery() {
    if (busy.current) return;
    busy.current = true; setWorking(true); setError(null);
    try {
      const moved = await moveStuckWritesToRecovery();
      if (moved > 0) addToast(tn("Moved 1 change to recovery.", "Moved {n} changes to recovery.", moved), "info");
      await flushPendingWrites();
    } catch (cause) { writeErrors.report(cause, inlineFeedback ? message => setError(message) : addToast); }
    finally { busy.current = false; setWorking(false); }
  }
  const waiting = tn("1 change waiting to sync", "{n} changes waiting to sync", pending);
  // Notes kept only on this device (the browser trial): there is no server to sync with, so the line says
  // where they are, and pressing it opens what the shell offers (backup, help).
  if (localOnly) {
    const line = localOnly.trouble ?? localOnly.label;
    return <div className={classNames("sync-control", expanded && "sync-control--expanded")}>
      <Pressable type="button" className={classNames("sync-status", "sync-status--btn", localOnly.trouble ? "offline has-pending" : "online")}
        onClick={localOnly.open} title={line} aria-label={line}>
        <span className={classNames("status-dot", localOnly.trouble ? "offline" : "online")} />
        <span className={expanded ? "sync-status-label" : "u-sr-only"}>{line}</span>
      </Pressable>
    </div>;
  }
  return <div className={classNames("sync-control", expanded && "sync-control--expanded")}>
    {pending > 0 ? <Pressable type="button"
      className={classNames("sync-status", "sync-status--btn", online ? "online" : "offline", "has-pending")}
      onClick={() => void syncNow()} disabled={!online || !onSyncNow || disabled}
      aria-disabled={working || undefined}
      title={online ? waiting : tn("Offline — 1 change will sync on reconnect", "Offline — {n} changes will sync on reconnect", pending)}
      aria-label={online ? tn("1 change waiting to sync — sync now", "{n} changes waiting to sync — sync now", pending) : waiting}>
      <span className={classNames("status-dot", online ? "online" : "offline")} />
      {!expanded && <span className="sync-pending-count">{pending}</span>}
      <span className="sync-status-label">{expanded ? waiting : online ? t("Sync now") : waiting}</span>
      {expanded && online && <span className="sync-status-action">{working ? t("Syncing…") : t("Sync now")}</span>}
    </Pressable> : online && incoming ? <Pressable type="button" className={classNames("sync-status", "sync-status--btn", "offline", "has-pending")}
      onClick={() => void syncNow()} disabled={!onSyncNow || disabled} aria-disabled={working || undefined}
      title={t(INCOMING_SENTENCES[incoming])} aria-label={t(INCOMING_SENTENCES[incoming])}>
      <span className="status-dot offline" />
      <span className={expanded ? "sync-status-label" : "u-sr-only"}>{t(INCOMING_SENTENCES[incoming])}</span>
      {expanded && <span className="sync-status-action">{working ? t("Syncing…") : t("Sync now")}</span>}
    </Pressable> : <span className={classNames("sync-status", online ? "online" : "offline")}
      title={online ? t("Connected") : t("Offline — changes save locally")}>
      <span className={classNames("status-dot", online ? "online" : "offline")} />
      <span className={expanded ? "sync-status-label" : "u-sr-only"}>{online ? t("Connected") : t("Offline — changes save locally")}</span>
    </span>}
    {stuck && expanded && <div className="sync-trouble" role="status">
      <p>{stuckSummary(t, stuck)}. {t(STUCK_REASONS[stuck.reason])}</p>
      {stuck.noteId && <p>{t("The oldest waiting change is in")}{" "}
        {onOpenNote ? <Pressable type="button" className="sync-trouble-action" onClick={() => onOpenNote(stuck.noteId!)}>{displayTitle(waitingNote?.title)}</Pressable>
          : <strong>{displayTitle(waitingNote?.title)}</strong>}</p>}
      <Pressable type="button" className="sync-trouble-action" onClick={() => void moveToRecovery()} disabled={working}>{t("Move to recovery")}</Pressable>
    </div>}
    {!stuck && expanded && pending > 0 && retry && RETRY_SENTENCES[retry.reason] && <div className="sync-trouble" role="status">
      <p>{t(RETRY_SENTENCES[retry.reason]!)}</p>
    </div>}
    {!expanded && (stuck || copyUnavailable) && <span className="sync-status offline has-pending" role="status">
      <span className="status-dot offline" />
      <span className="sync-status-label">{stuck ? stuckSummary(t, stuck) : t("This device's local copy cannot be saved")}</span>
    </span>}
    {error && <p className="sync-feedback" role="status">{error}</p>}
  </div>;
}
