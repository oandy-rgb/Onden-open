// Whether the trial version should urge "add to the Home Screen". On an iPad or iPhone, Safari clears what a site
// stored after seven days without a visit unless the site was added to the Home Screen (docs/architecture/browser-app.md
// §12.3); the backup reminder only shows when the app is opened, so it cannot cover the days the app stays closed.
// The rule is a pure function of the values passed in, so it is tested without a browser.

export type InstallEnv = {
  userAgent: string;
  platform: string;
  /** The device takes touch input. */
  hasTouch: boolean;
  /** The app runs from the Home Screen (Safari's own flag, or the standalone display mode). */
  standalone: boolean;
};

/** An iPhone, an iPod touch or an iPad (an iPad says "MacIntel" and gives itself away by taking touch). */
const isAppleTouchDevice = (env: InstallEnv): boolean =>
  /iPad|iPhone|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.hasTouch);

/** Pure: true on an iPad or iPhone where the app does not run from the Home Screen. The values come from
 *  lib/browserNetwork.ts `homeScreenEnv()` (the one place that reads them off the browser). */
export function shouldUrgeHomeScreen(env: InstallEnv): boolean {
  return isAppleTouchDevice(env) && !env.standalone;
}
