// The default workspace's id, for routes. Routes may not import db.ts directly (allowlist be-route-imports),
// so this is their one entry; the single-workspace assumption itself lives with the resolver in db.ts.
export { getWorkspaceId } from "../db.js";
