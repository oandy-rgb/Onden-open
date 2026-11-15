import { useEffect, useState } from "react";
import { TopLayerPortal, Button, layerClass } from "./ui";
import { useAppSelector, useOnline } from "../lib/appStore";
import { onAppResume } from "../lib/appResume";
import { useIsOwner } from "../lib/capabilities";
import { useT } from "../lib/i18n";
import { timeZoneQuestion, zonesDiffer } from "../lib/timeZoneAsk";
import { asksAboutDeviceZone, timeZoneAnsweredPref, timeZoneAskPref } from "../lib/timeZonePrefs";
import { changeClockAsking } from "./workspaceClockChange";
import { deviceTimeZone, zoneName } from "../lib/workspaceTime";
import "./TimeZoneAsk.css";

/** 旅行時詢問 (lib/timeZoneAsk): a small card that does not block the screen,
 *  shown to the owner when this device's time zone differs from the
 *  workspace's. Either answer is remembered for this device zone. */
export default function TimeZoneAsk() {
  const t = useT();
  const isOwner = useIsOwner();
  const online = useOnline();
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const chosenZone = useAppSelector((s) => s.data.workspace.time_zone ?? null);
  const defaultZone = useAppSelector((s) => s.data.timezone);
  const ask = timeZoneAskPref.useValue();
  const answered = timeZoneAnsweredPref.useValue();
  const [deviceZone, setDeviceZone] = useState(deviceTimeZone);
  const [busy, setBusy] = useState(false);

  // Re-read the device's zone when the app comes back into view: that is when
  // a trip shows up.
  useEffect(() => {
    return onAppResume(() => setDeviceZone(deviceTimeZone()), ["visible", "focus"]);
  }, []);

  const prefsSettled = ask.settled && answered.settled;
  const question = bootstrapped ? timeZoneQuestion({
    isOwner, online, asking: asksAboutDeviceZone(ask.value), prefsSettled,
    answered: answered.value, deviceZone, chosenZone, defaultZone,
  }) : null;

  // Back on a zone that matches the workspace's, with an answer about some
  // other zone still held: forget it, so the next trip there is asked about
  // again. (An answer for this very zone stays: the owner chose it.)
  const staleAnswer = bootstrapped && prefsSettled && !zonesDiffer(deviceZone, chosenZone ?? defaultZone ?? "UTC")
    && answered.value !== null && answered.value !== deviceZone;
  useEffect(() => {
    if (staleAnswer) answered.save(null);
  }, [staleAnswer, answered]);

  if (!question) return null;
  const place = zoneName(question.deviceZone);
  const home = zoneName(question.workspaceZone);

  async function change() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await changeClockAsking({ timeZone: question!.deviceZone });
      if (result === "changed" || result === "unchanged") answered.save(question!.deviceZone);
    } finally { setBusy(false); }
  }

  return (
    <TopLayerPortal>
      <aside className={`${layerClass.fixed} time-zone-ask`} role="status" aria-label={t("Time zone")}>
        <p className="time-zone-ask-text">
          {question.kind === "set"
            ? t("Set Onden's time zone to {place}?", { place })
            : t("Your device is now on {place} time. Change Onden's “today” to {place} time?", { place })}
        </p>
        <div className="time-zone-ask-actions">
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => void change()}>
            {question.kind === "set" ? t("Set to {place}", { place }) : t("Change to {place}", { place })}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => answered.save(question.deviceZone)}>
            {question.kind === "set" ? t("Not now") : t("Keep {place}", { place: home })}
          </Button>
        </div>
      </aside>
    </TopLayerPortal>
  );
}
