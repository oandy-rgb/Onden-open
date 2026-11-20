// A value in the form the server stored before purposes were authenticated (version 1, associated data = the
// row id only; services/serverSecret.ts). Built by hand here so no product code can still write it.
import { createCipheriv, randomBytes } from "node:crypto";

export function legacySealed(keyHex: string, rowId: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(rowId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}
