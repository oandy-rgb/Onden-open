import { applyPersistedSettings } from "./settings/appearance";
import "./lib/i18n.app"; // translation tables, before anything renders
import { installUuidPolyfill } from "./lib/uuid";
import { requestPersistentStorage } from "./lib/storagePersist";
import { stampLegacyNativeStore } from "./lib/accountStorage";
import { getApiBase } from "./lib/api";
import { installStaleChunkReload } from "./lib/installStaleChunkReload";
import { installPenShortcutBridge } from "./lib/penShortcutBridge";

let booted = false;

/** Page-level setup, run once before the app mounts, for every entry: the web
 *  build (index.astro mounts AppRoot) and the Vite/Capacitor build (main.tsx
 *  mounts AppRoot). AppRoot.tsx calls it, so an entry that mounts
 *  AppRoot cannot skip it. Add new page-level setup here, not in an entry. */
export function bootApp(): void {
  if (booted) return;
  booted = true;

  // crypto.randomUUID is secure-context-only and absent on a LAN-IP HTTP
  // self-host, where every client-id-minting mutation (note capture/create)
  // would throw. Install the getRandomValues fallback before anything mounts.
  installUuidPolyfill();

  // Replay persisted UI settings (font size, density, accent, theme…) into the
  // DOM before React mounts, so the first paint is not the defaults.
  applyPersistedSettings();

  // Ask the browser to make this origin's storage persistent (eviction-exempt)
  // so the offline mirror + pending-write queue — the only durable copy of
  // offline edits, on Android too — can't be silently reclaimed. Best-effort.
  void requestPersistentStorage();

  // Native: record which server the old unscoped local store belongs to,
  // before anything can change the server setting (lib/accountStorage).
  stampLegacyNativeStore(getApiBase());

  // A tab older than the last deploy asks for code-split files the server no
  // longer has: reload once onto the new build (lib/lazyWithReload.ts).
  installStaleChunkReload();

  // A native shell reports pen buttons / Apple Pencil gestures here
  // (lib/penShortcutBridge.ts). Nothing happens without a shell.
  installPenShortcutBridge();
}
