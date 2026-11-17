import { sendWrite } from "./onlineWrite";

// What a person does to the calendars they follow (external calendars). Online only; callers report failures through writeErrors.
export const calendarWriter = {
  /** `id` is minted per form attempt, so a retry follows the same calendar once. */
  follow: (input: { id: string; name: string; color: string; url: string }) => sendWrite("POST", "/api/external-calendars", input),
  change: (calendarId: string, patch: { name?: string; color?: string; enabled?: boolean }) => sendWrite("PATCH", `/api/external-calendars/${calendarId}`, patch),
  refresh: (calendarId: string) => sendWrite("POST", `/api/external-calendars/${calendarId}/refresh`, {}),
  stopFollowing: (calendarId: string) => sendWrite("DELETE", `/api/external-calendars/${calendarId}`),
};
