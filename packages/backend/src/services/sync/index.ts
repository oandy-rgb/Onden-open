// The sync protocol's reads (depth audit D8, D10): the cold-start bootstrap
// and what routes/sync.ts serves, as functions a test can call without HTTP.
// Each re-reads the authenticated actor in its own read snapshot
// (withActorReadSnapshot), so every read of a response sees one database
// state and the actor's current authority.
export { buildSyncDelta, MAX_KNOWN_IDS, readStandpoint } from "./delta.js";
export { membershipPage, membershipDigest, parseBucketPrefixes, nodesFor, SyncRequestTooLarge, MEMBERSHIP_PAGE_SIZE, MEMBERSHIP_PAGE_MAX } from "./membership.js";
export { bodiesFor, MAX_BODY_IDS } from "./bodies.js";
export { drawingIndex, drawingsFor, isDrawingsHeld, MAX_DRAWING_IDS } from "./drawings.js";
export { buildBootstrap } from "./bootstrap.js";
