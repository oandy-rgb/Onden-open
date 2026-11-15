import { useState } from "react";
import { AlertTriangle, ChevronDown, CircleCheck, RotateCcw, Trash2 } from "lucide-react";
import { confirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/ui";
import { useFailedDeliveries, type FailedDelivery, type FailedDeliveryGroup } from "../hooks/useFailedDeliveries";
import { effectKindLabel } from "../lib/effectKinds";
import { useT } from "../lib/i18n";
import { dayLabel, timeLabel } from "../lib/timeLabels";
import type { SettingContext } from "../lib/settingsTypes";

const when = (iso: string) => `${dayLabel(iso)} ${timeLabel(iso)}`;

// Settings › System status (owner only): background jobs that stopped
// retrying — backups, the website deploy, the search index — grouped by
// kind. They used to sit in the inbox; the inbox is for approvals now, and a
// failed job is not something to approve. Per kind: how many, the newest
// error, when the first and last failed, 全部重試 / 全部清除; each row can
// be retried on its own.

function Group({ group, rows, online, busy, onRetry, onRetryKind, onDismissKind }: {
  group: FailedDeliveryGroup;
  /** The kind's rows among the newest 100 listed. */
  rows: FailedDelivery[];
  online: boolean;
  busy: string | null;
  onRetry: (id: string) => void;
  onRetryKind: (kind: string) => void;
  onDismissKind: (kind: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = effectKindLabel(group.effect_kind);
  const kindBusy = busy === `kind:${group.effect_kind}`;
  return (
    <li className="settings-system-group" data-kind={group.effect_kind}>
      <div className="settings-system-group-head">
        <AlertTriangle size={14} aria-hidden="true" className="settings-danger-icon" />
        <strong className="settings-system-kind">{label}</strong>
        <span className="settings-system-count" aria-label={t("{n} failed jobs", { n: group.count })}>{group.count}</span>
      </div>
      <p className="settings-system-error">{t("It kept failing after repeated retries. Check this feature's settings or connection, then retry.")}</p>
      <p className="settings-hint">
        {group.count === 1
          ? t("Failed {time}", { time: when(group.newest_at) })
          : t("First failed {oldest} · last {newest}", { oldest: when(group.oldest_at), newest: when(group.newest_at) })}
      </p>
      <div className="settings-system-actions">
        <Button variant="secondary" size="sm" disabled={!online || kindBusy}
          onClick={() => onRetryKind(group.effect_kind)} title={t("Try every one again with a fresh day of retries")}>
          <RotateCcw size={13} /> {t("Retry all")}
        </Button>
        <Button variant="ghost" size="sm" disabled={!online || kindBusy}
          onClick={() => onDismissKind(group.effect_kind)} title={t("Stop showing these; they are not retried")}>
          <Trash2 size={13} /> {t("Clear all")}
        </Button>
        {rows.length > 0 && (
          <Button variant="ghost" size="sm" className="settings-system-toggle" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={13} className={open ? "settings-system-chev open" : "settings-system-chev"} />
            {open ? t("Hide the list") : t("Show {n}", { n: rows.length })}
          </Button>
        )}
      </div>
      {open && (
        <ul className="settings-system-rows">
          {rows.map((f) => (
            <li key={f.id} className="settings-system-row">
              <div className="settings-system-row-text">
                <span className="settings-hint">{t("{n} attempts", { n: f.attempts })} · {when(f.failed_at)}</span>
              </div>
              <Button variant="ghost" size="sm" disabled={!online || busy === f.id}
                onClick={() => onRetry(f.id)} title={t("Try again with a fresh day of retries")}>
                <RotateCcw size={13} /> {t("Retry")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SystemStatusSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const { isOwner, failed, groups, busy, retry, retryKind, dismissKind } = useFailedDeliveries(ctx.online);
  if (!isOwner) return null;
  const dismissKindConfirmed = async (kind: string) => {
    const group = groups.find((g) => g.effect_kind === kind);
    const ok = await confirmDialog(
      t("Clear {n} failed “{kind}” jobs? They are not retried. Jobs still waiting to run are not affected.", { n: group?.count ?? 0, kind: effectKindLabel(kind) }),
      { confirmLabel: t("Clear all"), cancelLabel: t("Cancel"), danger: true },
    );
    if (ok) await dismissKind(kind);
  };
  return (
    <div className="settings-system">
      <p className="settings-hint settings-hint--with-margin">
        {t("Background jobs (backups, the website deploy, the search index…) that still failed after about a day of retries.")}
      </p>
      {groups.length === 0 ? (
        <p className="settings-system-ok"><CircleCheck size={14} aria-hidden="true" /> {t("Every background job is running normally.")}</p>
      ) : (
        <ul className="settings-system-list">
          {groups.map((g) => (
            <Group key={g.effect_kind} group={g} rows={failed.filter((f) => f.effect_kind === g.effect_kind)}
              online={ctx.online} busy={busy}
              onRetry={(id) => void retry(id)} onRetryKind={(kind) => void retryKind(kind)}
              onDismissKind={(kind) => void dismissKindConfirmed(kind)} />
          ))}
        </ul>
      )}
    </div>
  );
}
