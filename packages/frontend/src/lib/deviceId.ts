// This browser's (or install's) own id: made once, kept in device-scope storage (lib/prefs), sent with every API
// request (lib/api) so the server can record which device a write came from. It is the device's, not the account's:
// it is never synced and signing in as someone else does not change it. Clearing site data makes a new one.
import { isUuid } from "@onden/markdown";
import { PREFS, getPref, setPref } from "./prefs";
import { randomUUID } from "./uuid";

/** Used only when storage is blocked: the id then lasts for this page load. */
let inMemory: string | null = null;

export function deviceId(): string {
  const stored = getPref(PREFS.deviceId);
  if (stored && isUuid(stored)) return stored;
  const made = inMemory ?? randomUUID();
  if (setPref(PREFS.deviceId, made)) inMemory = null;
  else inMemory = made;
  return made;
}
