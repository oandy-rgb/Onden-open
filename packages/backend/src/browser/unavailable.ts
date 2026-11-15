// What the browser app does not have, answered before the backend is asked (the same refusal for everyone,
// in the words serverErrors maps: browser_app_unavailable). Each line says why; none is a permission decision.
//
// Features that are modules (AI, RSS, skills, outside calendars, the website) are switched off in the
// packaged database instead, so they leave no trace (moduleOffNoTrace) and the backend's own gate answers them.

export type Unavailable = { feature: string };

type Rule = { feature: string; prefix: string; reason: string; /** Only these methods; omitted = all. */ methods?: readonly string[] };

export const UNAVAILABLE_IN_BROWSER_APP: readonly Rule[] = [
  // (Uploaded files are not here: they are kept in the browser's file space and shown through a Service Worker that
  // hands GET /api/media/* to the page and so to this worker — browser-app.md §6. Restoring a backup works too.)
  { feature: "web page titles", prefix: "/api/bookmark", reason: "a browser may not read other sites' pages (CORS)" },
  { feature: "push reminders", prefix: "/api/push", reason: "nothing can wake a closed page" },
];

export function unavailableInBrowserApp(method: string, path: string): Unavailable | null {
  const verb = method.toUpperCase();
  for (const rule of UNAVAILABLE_IN_BROWSER_APP) {
    if ((path === rule.prefix || path.startsWith(`${rule.prefix}/`)) && (!rule.methods || rule.methods.includes(verb))) return { feature: rule.feature };
  }
  return null;
}
