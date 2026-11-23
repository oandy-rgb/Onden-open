// The owner's own API keys, kept so the server can run the `api`
// runtime (services/agentRuntime/api). Decision: 2026-10-30, proposal §3.1, §7.3.
// A key belongs to one service: its address and the wire format it speaks
// (detected, or chosen by the owner; services/agentRuntime/api/protocols). The
// owner may also write down the service's price per million tokens, which only
// feeds an estimate shown next to the token counts.
//
//   • Stored only as ciphertext sealed by services/serverSecret.ts for the purpose
//     `ai-credential` and the row id (what is authenticated depends on the rollout
//     step written there: today only the row id). The key is ONDEN_SECRET_KEY, a deploy
//     environment variable: never in the database, never in a setting. A
//     ciphertext copied onto another row does not open.
//   • What leaves this module for a caller is the label and the last four
//     characters. The plaintext is returned only by loadApiKey(), which the
//     `api` runtime alone may import (test/guards/aiRuntime.guard.test.ts).
//   • No ONDEN_SECRET_KEY → no key can be added and the `api` runtime does not
//     exist for any role.
//   • A backup of the database holds the ciphertext: keep the backup and
//     ONDEN_SECRET_KEY apart (docs/agents/deploy.md).
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { isWorkspaceOwner, AuthorityError } from "../spine/authority.js";
import { AgentSessionError } from "./agentSessionError.js";
import { openSecret, requireSecretKey, sealSecret } from "./serverSecret.js";
import type { ProtocolId } from "./agentRuntime/index.js";

export type AiCredential = {
  id: string; label: string; last4: string; created_at: string; revoked_at: string | null;
  base_url: string; protocol: ProtocolId;
  /** USD per million tokens, written by the owner; both null when left blank. */
  price_input_per_m: number | null; price_output_per_m: number | null;
};

/** Any service's key: printable characters, no spaces. */
const API_KEY = /^[\x21-\x7e]{8,500}$/;

export async function assertOwner(actor: ActorCtx): Promise<void> {
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("principal_admin", "only the workspace owner manages API keys");
}

const COLS = `id::text, label, secret_last4 AS last4, created_at, revoked_at, base_url, protocol,
  price_input_per_m::float8 AS price_input_per_m, price_output_per_m::float8 AS price_output_per_m`;

/** The address as a clean http(s) URL without a trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AgentSessionError("invalid_base_url", "the service address is not a web address", 422); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new AgentSessionError("invalid_base_url", "the service address is not a plain http(s) address", 422);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Both prices or neither; a number from 0 up. Blank means "show tokens only". */
function pricesOf(input: number | null | undefined, output: number | null | undefined): { input: number | null; output: number | null } {
  if ((input == null) !== (output == null)) throw new AgentSessionError("invalid_price", "write both prices, or leave both blank", 422);
  if (input == null || output == null) return { input: null, output: null };
  if (![input, output].every((n) => Number.isFinite(n) && n >= 0 && n <= 1_000_000)) throw new AgentSessionError("invalid_price", "a price must be a number from 0 up", 422);
  return { input, output };
}

/** Keep a key (workspace owner only). The plaintext is not returned, logged or put
 *  in the event; only the label and the last four characters are. */
export async function addCredential(
  workspaceId: string,
  input: { label: string; apiKey: string; baseUrl: string; protocol: ProtocolId; inputPricePerM?: number | null; outputPricePerM?: number | null },
  { actor }: { actor: ActorCtx },
): Promise<AiCredential> {
  await assertOwner(actor); // before anything about the server's own setup is revealed
  const label = input.label.trim();
  const apiKey = input.apiKey.trim();
  if (!label || label.length > 80) throw new AgentSessionError("invalid_credential", "the label must be 1–80 characters", 422);
  if (!API_KEY.test(apiKey)) throw new AgentSessionError("invalid_credential", "that does not look like a valid API key", 422);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const prices = pricesOf(input.inputPricePerM, input.outputPricePerM);
  requireSecretKey();
  const { protocol } = input;
  const id = randomUUID();
  const last4 = apiKey.slice(-4);
  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "AI_CREDENTIAL_ADDED", targetType: "ai_credential", targetId: id, payload: { label, last4, base_url: baseUrl, protocol } },
    apply: async () => (await q<AiCredential>(
      `INSERT INTO ai_credentials (id, workspace_id, label, secret_ciphertext, secret_last4, created_by, base_url, protocol, price_input_per_m, price_output_per_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLS}`,
      [id, workspaceId, label, sealSecret("ai-credential", id, apiKey), last4, actor.id, baseUrl, protocol, prices.input, prices.output])).rows[0]!,
  });
}

/** Revoke a key. Roles that point at it stay as they are and become unable to run
 *  the api runtime (`no_key`); sessions in progress fail on their next call. */
export async function revokeCredential(workspaceId: string, credentialId: string, { actor }: { actor: ActorCtx }): Promise<AiCredential> {
  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "AI_CREDENTIAL_REVOKED", targetType: "ai_credential", targetId: credentialId, payload: {} },
    apply: async () => {
      const r = await q<AiCredential>(
        `UPDATE ai_credentials SET revoked_at = COALESCE(revoked_at, now())
          WHERE id::text = $1 AND workspace_id = $2 RETURNING ${COLS}`, [credentialId, workspaceId]);
      if (!r.rows[0]) throw new AgentSessionError("not_found", "key not found", 404);
      return r.rows[0];
    },
  });
}

export async function listCredentials(workspaceId: string, { actor }: { actor: ActorCtx }): Promise<AiCredential[]> {
  await assertOwner(actor);
  return (await q<AiCredential>(
    `SELECT ${COLS} FROM ai_credentials WHERE workspace_id = $1 ORDER BY created_at DESC`, [workspaceId])).rows;
}

/** Is there a live (not revoked) key with this id in the workspace? */
export async function credentialLive(workspaceId: string, credentialId: string): Promise<boolean> {
  return (await q(
    `SELECT 1 FROM ai_credentials WHERE id::text = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [credentialId, workspaceId])).rows.length > 0;
}

export async function anyLiveCredential(workspaceId: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM ai_credentials WHERE workspace_id = $1 AND revoked_at IS NULL LIMIT 1`, [workspaceId])).rows.length > 0;
}

/** The service a stored key belongs to, with the plaintext key — for the `api` runtime only (guarded by test). */
export async function loadService(workspaceId: string, credentialId: string): Promise<{ baseUrl: string; protocol: ProtocolId; apiKey: string; prices: { inputPerM: number; outputPerM: number } | null }> {
  const apiKey = await loadApiKey(workspaceId, credentialId);
  const row = (await q<{ base_url: string; protocol: string; input: number | null; output: number | null }>(
    `SELECT base_url, protocol, price_input_per_m::float8 AS input, price_output_per_m::float8 AS output FROM ai_credentials WHERE id::text = $1 AND workspace_id = $2`,
    [credentialId, workspaceId])).rows[0]!;
  return { baseUrl: row.base_url, protocol: row.protocol as ProtocolId, // the column's CHECK allows only known formats
    apiKey, prices: row.input == null || row.output == null ? null : { inputPerM: row.input, outputPerM: row.output } };
}

/** The plaintext key — for the `api` runtime only (guarded by test). Refuses a
 *  revoked key, so revoking stops the next call of a session already running. */
export async function loadApiKey(workspaceId: string, credentialId: string): Promise<string> {
  const row = (await q<{ id: string; secret_ciphertext: Buffer; revoked_at: string | null }>(
    `SELECT id::text, secret_ciphertext, revoked_at FROM ai_credentials WHERE id::text = $1 AND workspace_id = $2`,
    [credentialId, workspaceId])).rows[0];
  if (!row || row.revoked_at) throw new AgentSessionError("credential_revoked", "the API key was revoked", 409);
  return openSecret("ai-credential", row.id, row.secret_ciphertext);
}
