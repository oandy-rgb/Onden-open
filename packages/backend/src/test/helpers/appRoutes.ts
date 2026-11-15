// Route inventory for the sweep tests (permissionMatrix, writePermissionMatrix):
// every route the REAL assembled app mounted, read from the Hono router, so a
// newly mounted route is swept without anyone remembering to list it.

export type MountedRoute = { method: string; path: string };

/** Mounted routes whose method passes `wanted`, once per (method, path), sorted.
 *  Middleware registered with `use` shows up as method ALL: leave it out. */
export function mountedRoutes(app: unknown, wanted: (method: string) => boolean): MountedRoute[] {
  const seen = new Map<string, MountedRoute>();
  for (const r of (app as { routes: MountedRoute[] }).routes) {
    if (wanted(r.method)) seen.set(`${r.method} ${r.path}`, { method: r.method, path: r.path });
  }
  return [...seen.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
