import { q, withTransaction } from "../../db.js";

// A person's own review settings for one source tag (actor_module_settings),
// layered over the tag's shared settings. The route checks the tag is
// visible and validates the values before calling.

/** Replace the stored settings. */
export async function replacePersonalSettings(actorId: string, tagId: string, settings: Record<string, unknown>): Promise<void> {
  await q(`INSERT INTO actor_module_settings(actor_id,tag_id,settings) VALUES($1,$2,$3)
    ON CONFLICT(actor_id,tag_id) DO UPDATE SET settings=EXCLUDED.settings, updated_at=now()`,
  [actorId, tagId, JSON.stringify(settings)]);
}

/** Merge into the stored settings: a field sent replaces that field, null
 *  removes it, a field not sent is kept. Answers the result, or null when it
 *  is empty (the row is then removed). */
export async function mergePersonalSettings(
  actorId: string, tagId: string, patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return withTransaction(async () => {
    const current = (await q<{ settings: Record<string, unknown> }>(
      "SELECT settings FROM actor_module_settings WHERE actor_id=$1 AND tag_id=$2 FOR UPDATE", [actorId, tagId])).rows[0]?.settings ?? {};
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    if (Object.keys(merged).length === 0) {
      await q("DELETE FROM actor_module_settings WHERE actor_id=$1 AND tag_id=$2", [actorId, tagId]);
      return null;
    }
    await replacePersonalSettings(actorId, tagId, merged);
    return merged;
  });
}

/** Remove the person's settings for the tag. */
export async function clearPersonalSettings(actorId: string, tagId: string): Promise<void> {
  await q("DELETE FROM actor_module_settings WHERE actor_id=$1 AND tag_id=$2", [actorId, tagId]);
}
