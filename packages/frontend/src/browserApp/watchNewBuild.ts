import { noteServerBuild } from "../lib/buildVersion";
import { documentBaseUrl, isPageHidden } from "../lib/documentAccess";

// The trial version's "is there a newer one": the published folder carries build.json ({ "build": "<id>" }, written by
// scripts/build-browser.mjs). When it names another build than this page was built from, the normal 「有新版，重新載入」
// notice appears (components/DeviceNotices); pressing it saves open text first (lib/lazyWithReload) and the worker
// saves its copy when the page goes away. The check never changes anything by itself.

const EVERY_MS = 5 * 60_000;

async function check(): Promise<void> {
  if (isPageHidden()) return;
  try {
    const response = await fetch(new URL("build.json", documentBaseUrl()).href, { cache: "no-store" });
    if (!response.ok) return;
    const { build } = (await response.json()) as { build?: unknown };
    if (typeof build === "string") noteServerBuild(build);
  } catch {
    // Offline or the file is not there (a local build): nothing to say.
  }
}

/** Starts checking; returns the stop function. */
export function watchNewBuild(): () => void {
  void check();
  const timer = setInterval(() => void check(), EVERY_MS);
  return () => clearInterval(timer);
}
