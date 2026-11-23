// The server's one secret key (ONDEN_SECRET_KEY) and the only code that encrypts or decrypts with it. Callers name the purpose
// of what they keep: services/aiCredentials.ts (`ai-credential`) and modules/external_calendars/store.ts (`external-calendar`);
// test/guards/serverSecret.guard.test.ts keeps the cipher calls and the key's name in this file.
//
// Stored form: [version 1 byte][iv 12][tag 16][ciphertext], AES-256-GCM. The version says what the cipher authenticated:
//   version 1: `<row id>`. A copy onto another row does not open, but a copy into the other table under the same id does:
//     a version 1 value opens for EITHER purpose.
//   version 2: `<purpose>:<row id>`. Opens only for the purpose and row it was sealed for.
//
// Rolled out in two deploys so that going back one version never loses a secret (owner review, PR #1923):
//   step 1 (this version): opens both versions, still WRITES version 1 and rewrites nothing. The version before it reads
//     everything this one writes.
//   step 2 (a later deploy, not done): write version 2 (WRITE_VERSION), and rewrite every version 1 row as version 2 when it is read
//     and once at boot; then refuse version 1. Until step 2 the purpose protects nothing that is stored.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { AgentSessionError } from "./agentSessionError.js";

/** What a sealed value is for. From version 2 on, part of what the cipher authenticates. */
type SecretPurpose = "ai-credential" | "external-calendar";

const LEGACY_VERSION = 1;
const PURPOSE_VERSION = 2;
/** What sealSecret() writes. Step 1 of the rollout above: still version 1, which the previous deploy can read. */
const WRITE_VERSION: typeof LEGACY_VERSION | typeof PURPOSE_VERSION = LEGACY_VERSION;

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

/** Seal `plaintext` for `purpose` and the row `rowId`, in WRITE_VERSION's form. Throws `secret_key_missing` without a key. */
export function sealSecret(purpose: SecretPurpose, rowId: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireSecretKey(), iv);
  cipher.setAAD(aad(WRITE_VERSION, purpose, rowId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([WRITE_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Open a value sealed for `purpose` and `rowId` (either version). Throws 409 `credential_unreadable` for a value sealed for
 *  another row, a version 2 value sealed for another purpose, a tampered or cut value, an unknown version, or the wrong key —
 *  without saying which. A version 1 value carries no purpose and opens for either (see the rollout above). */
export function openSecret(purpose: SecretPurpose, rowId: string, sealed: Buffer): string {
  const version = sealed[0];
  if ((version !== PURPOSE_VERSION && version !== LEGACY_VERSION) || sealed.length < 29) throw unreadable();
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
