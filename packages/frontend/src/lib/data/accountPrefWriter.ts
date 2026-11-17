import { sendWrite } from "./onlineWrite";

/** Save one account preference (PUT /api/me/prefs/:key). `body` is `{ value }`, plus `editAgeMs` for a conditional save; the answer says whether it applied. */
export const accountPrefWriter = {
  save: (key: string, body: { value: unknown; editAgeMs?: number }) =>
    sendWrite<{ value?: unknown; applied?: boolean } | undefined>("PUT", `/api/me/prefs/${key}`, body),
};
