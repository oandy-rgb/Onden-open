import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { sha256Hex } from "../../utils.js";
import type { ActorCtx } from "../../types.js";

/** A live ticket for `purpose` handed to `actor`, written the way services/freshProof.ts stores one (the hash only), WITHOUT the evidence check: for a test that
 *  is about what a guarded route does with a ticket and whose people have no password account. What the evidence check itself does is
 *  freshProof.integration.test.ts, through issueFreshProof. Run it inside onNode of the database the route reads. */
export async function ticketWithoutEvidence(actor: ActorCtx, purpose = "snapshot_export"): Promise<string> {
  const ticket = randomBytes(32).toString("base64url");
  await db.insertInto("fresh_proofs").values({ ticket_hash: sha256Hex(ticket), actor_id: actor.id, purpose, expires_at: sql<Date>`now() + interval '2 minutes'` }).execute();
  return ticket;
}
