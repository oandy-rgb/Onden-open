// The models a key can use: asked of the service itself (its model list), never
// listed here, so Onden keeps no model list and picks no default.
import { q } from "../../../db.js";
import { loadService } from "../../aiCredentials.js";
import { protocolClient, type ProtocolId, type ProviderModel } from "./protocols/index.js";

export type ApiModel = ProviderModel;

export async function listModels(workspaceId: string, credentialId: string): Promise<ApiModel[]> {
  const service = await loadService(workspaceId, credentialId);
  return protocolClient(service.protocol, service).listModels();
}

/** The chosen model is gone: pause the role's api runtime until a new one is
 *  chosen. Nothing is switched for the owner. */
export async function markModelRetired(actorId: string): Promise<void> {
  await q(`UPDATE agent_runners SET api_model_retired_at = COALESCE(api_model_retired_at, now()) WHERE actor_id = $1`, [actorId]);
}

/** The models of a kept key and the format its service speaks (the owner's "Test"): the plaintext key is read here, in the api runtime, and goes no further. */
export async function listModelsWithFormat(workspaceId: string, credentialId: string): Promise<{ protocol: ProtocolId; models: ApiModel[] }> {
  const service = await loadService(workspaceId, credentialId);
  return { protocol: service.protocol, models: await protocolClient(service.protocol, service).listModels() };
}
