// Adding a key as the owner does it: the format of the service is detected from its address and key, and the
// owner is asked to choose only when it cannot be told. (Kept apart from aiCredentials.ts, the store, so the
// store does not depend on the api runtime that reads from it.)
import type { ActorCtx } from "../types.js";
import { AgentSessionError } from "./agentSessionError.js";
import { addCredential, assertOwner, normalizeBaseUrl, type AiCredential } from "./aiCredentials.js";
import { detectProtocol, listModelsWithFormat, ProtocolError, protocolClient, type ProtocolId, type ProviderModel } from "./agentRuntime/index.js";

/** The format the service speaks, read from its answer; the owner picks one when it cannot be told. */
export async function detect(baseUrl: string, apiKey: string): Promise<ProtocolId> {
  try {
    const found = await detectProtocol({ baseUrl, apiKey });
    if (found) return found;
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "credential_rejected") throw new AgentSessionError("credential_rejected", "the service did not accept this key", 422);
    if (error instanceof ProtocolError) throw new AgentSessionError("service_unreachable", "the service could not be reached", 422);
    throw error;
  }
  throw new AgentSessionError("protocol_undetected", "the format of this service could not be told; choose it", 422);
}

export async function addCredentialDetectingFormat(
  workspaceId: string,
  input: { label: string; apiKey: string; baseUrl: string; protocol?: ProtocolId; inputPricePerM?: number | null; outputPricePerM?: number | null },
  { actor }: { actor: ActorCtx },
): Promise<AiCredential> {
  // The owner check and the address check come first: nothing is sent to an address for someone who may not add keys.
  await assertOwner(actor);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const protocol = input.protocol ?? await detect(baseUrl, input.apiKey.trim());
  return addCredential(workspaceId, { ...input, protocol }, { actor });
}

/** Ask a service with a key and say what it answered: the models it lists, or why not (a refused key and an
 *  unreachable service are told apart). The one place both "test" entries word that. */
export async function askService(protocol: ProtocolId, target: { baseUrl: string; apiKey: string }): Promise<ProviderModel[]> {
  try {
    return await protocolClient(protocol, target).listModels();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "credential_rejected") throw new AgentSessionError("credential_rejected", "the service did not accept this key", 422);
    throw new AgentSessionError("service_unreachable", "the service could not be reached", 422);
  }
}

/** "Test" before a key is kept: ask the service with this key, saving nothing. Succeeds with the format it speaks
 *  and the models it lists, so the owner knows the key works (and can pick a model from that very list). */
export async function testCredential(
  input: { apiKey: string; baseUrl: string; protocol?: ProtocolId },
  { actor }: { actor: ActorCtx },
): Promise<{ protocol: ProtocolId; models: ProviderModel[] }> {
  await assertOwner(actor);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  const protocol = input.protocol ?? await detect(baseUrl, apiKey);
  return { protocol, models: await askService(protocol, { baseUrl, apiKey }) };
}

/** "Test" a key that is already kept. Same answers as testCredential; a deleted key is 409 credential_revoked. */
export async function testStoredCredential(workspaceId: string, credentialId: string, { actor }: { actor: ActorCtx }): Promise<{ protocol: ProtocolId; models: ProviderModel[] }> {
  await assertOwner(actor);
  try {
    return await listModelsWithFormat(workspaceId, credentialId);
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    if (error instanceof ProtocolError && error.code === "credential_rejected") throw new AgentSessionError("credential_rejected", "the service did not accept this key", 422);
    throw new AgentSessionError("service_unreachable", "the service could not be reached", 422);
  }
}
