// First import of the worker: the environment config.ts and db.ts read at import time.
// ES modules evaluate in import order, so this must come before anything that imports db.ts.
// (`process` is the build's stand-in object: packages/backend/browser-shims/globals.mjs.)
import { setEnvironment } from "../config.js";

const bytes = crypto.getRandomValues(new Uint8Array(32));
const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

setEnvironment({
  // Real sessions (the native-origin bypass is forced off in production). Nothing here is reachable from
  // another machine: the worker answers only its own page.
  NODE_ENV: "production",
  ONDEN_DB_DRIVER: "pglite",
  // PGlite runs in memory; worker.ts saves copies to OPFS / IndexedDB (snapshotStore.ts).
  ONDEN_PGLITE_DIR: "memory://",
  // The session cookie is signed with a secret made on every start: the worker signs in again each time.
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: "http://localhost",
  LOG_LEVEL: "warn",
  ONDEN_BROWSER_APP: "1",
});

// "Today" follows the browser's zone until the person picks one in settings.
setEnvironment({ ONDEN_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
export {};
