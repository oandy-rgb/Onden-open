// The server's one secret key (ONDEN_SECRET_KEY) and the only code that encrypts or decrypts with it.
// Every secret it keeps is sealed for a purpose and a row: what the cipher authenticates is
// `<purpose>:<row id>`, so a ciphertext copied onto another row — or into another table that keeps a
// different kind of secret under the same id — does not decrypt. Callers: services/aiCredentials.ts
// (`ai-credential`) and modules/external_calendars/store.ts (`external-calendar`); test/guards/serverSecret.guard.test.ts
// keeps the cipher calls and the key's name in this file.
//
// Stored form: [version 1 byte][iv 12][tag 16][ciphertext], AES-256-GCM.
//   version 2 (now): associated data `<purpose>:<row id>`.
//   version 1 (before 2026-11-20): associated data `<row id>` only. Still read, so no saved row becomes
//     unreadable; openStoredSecret() rewrites it as version 2 the first time it is read. A version 1 value
//     carries no purpose, so until then it is only as strongly bound as it always was (to its row id).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { AgentSessionError } from "./agentSessionError.js";

/** What a sealed value is for. Part of what the cipher authenticates: a value sealed for one never opens as another. */
type SecretPurpose = "ai-credential" | "external-calendar";

const LEGACY_VERSION = 1;
const VERSION = 2;

/** ONDEN_SECRET_KEY: 32 bytes as 64 hex characters or as base64. Null when unset or malformed. */
function secretKey(): Buffer | null {
  const raw = config.str("ONDEN_SECRET_KEY")?.trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export const secretKeyConfigured = (): boolean => secretKey() !== null;

/** The key, or 409 `secret_key_missing` when the server has none (nothing can be sealed or opened then). */
export function requireSecretKey(): Buffer {
  const key = secretKey();
  if (!key) throw new AgentSessionError("secret_key_missing", "the server has no ONDEN_SECRET_KEY, so it cannot keep API keys", 409);
  return key;
}

const aad = (version: number, purpose: SecretPurpose, rowId: string): Buffer =>
  Buffer.from(version === LEGACY_VERSION ? rowId : `${purpose}:${rowId}`);

/** Seal `plaintext` for `purpose` and the row `rowId` (current version). Throws `secret_key_missing` without a key. */
export function sealSecret(purpose: SecretPurpose, rowId: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireSecretKey(), iv);
  cipher.setAAD(aad(VERSION, purpose, rowId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Open a value sealed for `purpose` and `rowId` (either version). Throws 409 `credential_unreadable` for a value sealed for
 *  another purpose or row, a tampered value, an unknown version, or the wrong key — without saying which. */
function openSecret(purpose: SecretPurpose, rowId: string, sealed: Buffer): string {
  const version = sealed[0];
  if ((version !== VERSION && version !== LEGACY_VERSION) || sealed.length < 29) throw unreadable();
  const decipher = createDecipheriv("aes-256-gcm", requireSecretKey(), sealed.subarray(1, 13));
  decipher.setAAD(aad(version, purpose, rowId));
  decipher.setAuthTag(sealed.subarray(13, 29));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString("utf8");
  } catch {
    throw unreadable();
  }
}

// The code the settings page already words ("The saved API key can't be read"); a calendar's address is never shown.
const unreadable = () => new AgentSessionError("credential_unreadable", "the stored secret cannot be read", 409);

/** Sealed before purposes were authenticated (version 1). */
export const isLegacySealed = (sealed: Buffer): boolean => sealed[0] === LEGACY_VERSION;

/** Where a store writes the current form of a value it just opened: `to` replaces `from` only where the row still
 *  holds `from` (a row changed meanwhile is left alone). The plaintext is the same. */
export type Reseal = (from: Buffer, to: Buffer) => Promise<void>;

/** openSecret() for a stored value: one in the old form (version 1) is rewritten in the current form through `reseal`
 *  before the plaintext is returned, so from then on it is bound to its purpose. This is the one upgrade path: every
 *  read of a stored secret goes through it. A failed rewrite fails the read (nothing is swallowed); the row keeps its
 *  old value and opens on the next try. */
export async function openStoredSecret(purpose: SecretPurpose, rowId: string, sealed: Buffer, reseal: Reseal): Promise<string> {
  const plaintext = openSecret(purpose, rowId, sealed);
  if (isLegacySealed(sealed)) {
    await reseal(sealed, sealSecret(purpose, rowId, plaintext));
    log.info("secrets", `${purpose}: a value from before purposes were authenticated was resealed`);
  }
  return plaintext;
}
