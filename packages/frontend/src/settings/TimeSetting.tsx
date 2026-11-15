import { useState } from "react";
import { TimeZonePicker } from "../components/TimeZonePicker";
import { Button, Select, Switch } from "../components/ui";
import { useAppSelector } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { changeClockAsking } from "../components/workspaceClockChange";
import { asksAboutDeviceZone, timeZoneAskPref } from "../lib/timeZonePrefs";
import { deviceTimeZone, hourLabel, workspaceZoneOf, zoneLabel } from "../lib/workspaceTime";
import { DataRow } from "./DataRow";
import OwnerLock from "../components/OwnerLock";
import type { SettingContext } from "../lib/settingsTypes";

// Settings › Date and time: the zone the workspace's days are cut in (backend
// localDay.ts). Shared by everyone in the workspace; only the owner changes it
// (the server refuses anyone else; for everyone else the controls are shown
// disabled, with a lock). Every change goes through lib/workspaceClock, which
// confirms one that moves today. The hour a day starts at (DayStartSetting) is the
// next row of this page. 「裝置時區不同時問我」 is the owner's own
// preference, not the workspace's.

const HOURS = [0, 1, 2, 3, 4, 5, 6];

/** Changes the workspace's clock one request at a time. */
function useClockChange() {
  const [busy, setBusy] = useState(false);
  async function change(next: Parameters<typeof changeClockAsking>[0]) {
    if (busy) return;
    setBusy(true);
    try { await changeClockAsking(next); } finally { setBusy(false); }
  }
  return { busy, change };
}

export default function TimeSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useAppSelector((s) => s.data.actor_is_owner === true);
  const chosen = useAppSelector((s) => s.data.workspace.time_zone ?? null);
  const zone = useAppSelector((s) => workspaceZoneOf(s.data)) ?? "UTC";
  const ask = timeZoneAskPref.useValue();
  const { busy, change } = useClockChange();
  const device = deviceTimeZone();
  const readOnly = !isOwner;

  return (
    <>
      <DataRow
        title={t("Time zone")}
        hint={chosen === null ? t("{zone}, the default. Not chosen yet.", { zone: zoneLabel(zone) }) : zoneLabel(zone)}
        action={readOnly ? <OwnerLock /> : zone !== device ? (
          <Button variant="secondary" disabled={busy || !ctx.online}
            onClick={() => void change({ timeZone: device })}>
            {t("Use this device's time zone ({zone})", { zone: zoneLabel(device) })}
          </Button>
        ) : undefined}
      >
        <TimeZonePicker zone={zone} device={device} disabled={readOnly || busy || !ctx.online}
          onPick={(next) => void change({ timeZone: next })} />
        {!readOnly && !ctx.online && <p className="settings-hint">{t("Connect to change the time settings.")}</p>}
      </DataRow>

      {isOwner && (
        <DataRow
          title={t("Ask me when this device's time zone differs")}
          hint={t("Travelling? Onden asks once whether to switch today to the time zone you are in.")}
          action={(
            <Switch on={asksAboutDeviceZone(ask.value)} label={t("Ask me when this device's time zone differs")} onChange={ask.save} />
          )}
        />
      )}
    </>
  );
}

/** The hour a day starts at (Settings › Date and time): what is written before it
 *  still counts as the day before. Workspace-wide, owner only. */
export function DayStartSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useAppSelector((s) => s.data.actor_is_owner === true);
  const dayStartHour = useAppSelector((s) => s.data.workspace.day_start_hour ?? 0);
  const { busy, change } = useClockChange();
  return (
    <DataRow
      title={t("When the day starts")}
      hint={t("If you stay up late, what you write before this time still counts as the day before.")}
      action={(
        <>
          {!isOwner && <OwnerLock />}
          <Select className="settings-input" aria-label={t("When the day starts")} value={dayStartHour}
            disabled={!isOwner || busy || !ctx.online}
            onChange={(e) => void change({ dayStartHour: Number(e.target.value) })}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </Select>
        </>
      )}
    />
  );
}
