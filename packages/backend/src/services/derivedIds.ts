// The id of a row Onden makes by itself, computed from what the row is for (migration 201, proposal distributed-ready §4.5):
// two devices that each make "the capture tag of this workspace" while offline make it with the same id, so a merge sees
// one row. The same v5 mechanism as a day note's id (services/dayNotes.ts); the names are @onden/markdown `derivedIdName`.
// The database makes the default space and a person's personal space itself with the same derivation (onden_space_id).

import { DERIVED_ID_NAMESPACE } from "@onden/markdown";
import { db } from "../dbKysely.js";
import { uuidV5 } from "../utils.js";
import { randomUUID } from "node:crypto";

/** The derived id of `name` (a `derivedIdName` result). */
export const derivedId = (name: string): string => uuidV5(DERIVED_ID_NAMESPACE, name);

/** The id to give a NEW row of `table` made for `name`: the derived one, or a random one when another row already has it (a
 *  trashed tag of the same purpose, a note someone gave that id): making the row must not fail on the derivation, and a
 *  second maker that finds the live row by its role never gets here. Runs in the caller's transaction. */
export async function newIdFor(table: "content_nodes" | "spaces", name: string): Promise<string> {
  const id = derivedId(name);
  const taken = table === "spaces"
    ? await db.selectFrom("spaces").select("id").where("id", "=", id).executeTakeFirst()
    : await db.selectFrom("content_nodes").select("id").where("id", "=", id).executeTakeFirst();
  return taken ? randomUUID() : id;
}
