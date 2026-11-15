// What a person may paste as a calendar's address, and the one part of it that is
// safe to show again. The address is a secret (private calendars carry a token in
// it), so nothing but the host ever leaves the server once it is saved.

export const MAX_URL_LENGTH = 2000;

export type CalendarUrl = { href: string; host: string };

/** https or http, or the webcal: spelling of https. Anything else, or an address
 *  with no host, is refused here; private and local hosts are refused later, at
 *  connect time, by safeFetch (the answer of the DNS lookup is what counts). */
export function parseCalendarUrl(raw: unknown): CalendarUrl | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  const text = /^webcal:\/\//i.test(trimmed) ? `https://${trimmed.slice("webcal://".length)}` : trimmed;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return { href: url.href, host: url.hostname.replace(/^\[|\]$/g, "") };
}
