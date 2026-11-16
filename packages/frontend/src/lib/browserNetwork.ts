// What the browser says about the network. Kept apart from lib/data/connectivity (which pulls in the sync engine)
// and outside lib/data so a light module (lazyWithReload, on the boot path) can ask without loading the data layer;
// the sync engine, the write queue and note search ask here too.

import type { InstallEnv } from "./browserAppInstall";
import { hasAnyCoarsePointer, runsStandalone } from "./mediaQuery";
/** The browser's own network state: false only when it says offline. True where it cannot be asked
 *  (no `navigator`), so a missing answer never blocks a request. */
export function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** The browser's Data Saver switch (Network Information API; absent in most desktop browsers). */
export function prefersSavedData(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/** The browser's name and major version ("Chrome 130"), for a report the person copies; never the full identification string. */
export function browserSummary(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const pick = (name: string, pattern: RegExp) => { const m = pattern.exec(ua); return m ? `${name} ${m[1]}` : null; };
  const family = pick("Edge", /Edg\/(\d+)/) ?? pick("Firefox", /Firefox\/(\d+)/) ?? pick("Chrome", /(?:Chrome|CriOS)\/(\d+)/) ?? pick("Safari", /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/) ?? "unknown";
  const system = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown system";
  return `${family} on ${system}`;
}

/** What lib/browserAppInstall.ts needs to know about this browser to decide whether to urge "add to the Home Screen". */
export function homeScreenEnv(): InstallEnv {
  if (typeof navigator === "undefined") return { userAgent: "", platform: "", hasTouch: false, standalone: false };
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || runsStandalone();
  return { userAgent: navigator.userAgent, platform: navigator.platform, hasTouch: hasAnyCoarsePointer(), standalone };
}
