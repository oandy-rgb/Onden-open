/** Is `value` a canonical 8-4-4-4-12 hex UUID (any version, either case)?
 *  The one definition for "this looks like a node/actor/tag id" input checks. */
/** The 8-4-4-4-12 shape as a RegExp source (no anchors), for patterns that find
 *  an id inside a longer string, such as `onden://node/<id>`. */
export const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
