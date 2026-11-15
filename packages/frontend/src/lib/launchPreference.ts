import { PREFS, getPref } from "./prefs";

export type LaunchPreference = "today" | "home" | "resume";

/** An optional navigation preference. Unavailable/obsolete values fall back
 * for this launch only; reading never overwrites the stored choice. */
export function getLaunchPreference(): LaunchPreference {
  const value = getPref(PREFS.launchLanding);
  return value === "home" || value === "resume" ? value : "today";
}
