// The built-in System actor's identity: the account the native bypass signs in
// as (local development and tests), seeded by migration 001 and reconciled in
// db.ts. Its one marker is actors.external_id = SYSTEM_EXTERNAL_ID.
//
// A leaf module on purpose: db.ts, spine/authority.ts and services/actors.ts
// all need it, and services/actors.ts imports both of those, so the constant
// cannot live there without an import cycle.

/** actors.external_id of the built-in System actor. */
export const SYSTEM_EXTERNAL_ID = "system";

/** SYSTEM_EXTERNAL_ID as a SQL string literal, for queries that compare
 *  against it inline (`a.external_id = ${SYSTEM_EXTERNAL_ID_SQL}`). A fixed
 *  constant, so interpolating it is not an injection path. */
export const SYSTEM_EXTERNAL_ID_SQL = `'${SYSTEM_EXTERNAL_ID}'`;
