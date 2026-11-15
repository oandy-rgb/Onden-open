// The two account preferences behind 「裝置時區不同時問我」 (lib/syncedPrefStore,
// pref keys timeZoneAsk and timeZoneAnswered; backend services/actorPrefs.ts).
// Both are the person's own: they change no workspace setting, and they follow
// the account to every device.
//
//   • timeZoneAsk: whether the owner is asked when this device's zone differs
//     from the workspace's. Never edited (null) reads as on.
//   • timeZoneAnswered: the device zone already answered. That zone is not
//     asked about again; a different one — the home zone on the way back
//     included — can be.

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";

export const timeZoneAskPref = createAccountPref<boolean>({
  serverKey: "timeZoneAsk",
  follows: "account", // whether to ask about the time zone: the person's answer
  copy: PREFS.timeZoneAskCopy,
  parse: (value) => (typeof value === "boolean" ? value : null),
});

export const timeZoneAnsweredPref = createAccountPref<string>({
  serverKey: "timeZoneAnswered",
  follows: "account", // the time zone they confirmed: the person's, not the device's
  copy: PREFS.timeZoneAnsweredCopy,
  parse: (value) => (typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null),
});

/** Whether the owner wants the question (on until switched off). */
export const asksAboutDeviceZone = (value: boolean | null): boolean => value !== false;
