// Stored secrets built and read by hand, the way services/serverSecret.ts lays them out, so a test can say what another
// version of the server would do with a value: version 1 (associated data = the row id, what the previous deploy reads
// and writes) and version 2 (associated data = `<purpose>:<row id>`, written from step 2 of the rollout on).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function sealWith(version: 1 | 2, keyHex: string, associated: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(associated));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), body]);
}

/** A version 1 value: what the previous deploy writes. */
export const legacySealed = (keyHex: string, rowId: string, plaintext: string): Buffer => sealWith(1, keyHex, rowId, plaintext);

/** A version 2 value: bound to its purpose. */
export const purposeSealed = (keyHex: string, purpose: string, rowId: string, plaintext: string): Buffer =>
  sealWith(2, keyHex, `${purpose}:${rowId}`, plaintext);

/** What the previous deploy (aiCredentials.ts decryptSecret on main before PR #1923) does with a stored value: it refuses any
 *  version but 1 and authenticates the row id only. Null where it could not read the value. */
export function openAsPreviousDeploy(keyHex: string, rowId: string, sealed: Uint8Array): string | null {
  const blob = Buffer.from(sealed);
  if (blob[0] !== 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(rowId));
    decipher.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
