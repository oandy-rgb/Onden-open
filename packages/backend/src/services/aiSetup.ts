// Making an AI as the owner's 設定 › AI page does: the connection it runs on, the AI itself, its @handle,
// where it stands in each space, and switched on — in ONE transaction, so a refusal at any step (a key the
// service rejects, a taken name, a model that is gone) leaves nothing behind: no AI without a connection,
// no key nobody asked to keep. Every step is the existing domain operation (createActor, configureRunner,
// setRoleRuntime, setMember, mintToken); this file only orders them.
//
// Where it stands: "edit" in each shared space whose "AI can read" switch is ON, nowhere else (owner 2026-11-11:
// the API runtime needs "edit", so with "view" the first use stopped at 「還不能用」). It never
// turns that switch on, and an AI is born suggest-only (createActor starts every agent in `suggest`).
import type { AiConnectionInput, SetUpAiRequest, SetUpAiResult } from "@onden/contract";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { createActor, mintToken } from "./actors.js";
import { AgentSessionError } from "./agentSessionError.js";
import { configureRunner, setRunnerEnabled } from "./agentSessions.js";
import { addCredential, assertOwner, normalizeBaseUrl } from "./aiCredentials.js";
import { askService, detect } from "./aiCredentialSetup.js";
import { setRoleRuntime } from "./aiRoles.js";
import { isProtocolId, listModels, type ApiModel, type ProtocolId } from "./agentRuntime/index.js";
import { sharedSpaceIdsWithCapability } from "../spine/spaceScope.js";
import { setMember } from "./spaces.js";

/** `ai`, else `ai2`, `ai3`… : the first handle no other AI in the workspace answers to. */
async function freeHandle(workspaceId: string, wanted: string | undefined): Promise<string> {
  const taken = new Set((await db.selectFrom("agent_runners").select("handle").where("workspace_id", "=", workspaceId).execute()).map((r) => r.handle));
  if (wanted) return wanted; // a chosen handle is the owner's: a clash is told (handle_taken), never silently changed
  if (!taken.has("ai")) return "ai";
  for (let n = 2; n < 1000; n++) if (!taken.has(`ai${n}`)) return `ai${n}`;
  throw new AgentSessionError("invalid_runner", "no free @name was found", 409);
}

export async function setUpAi(workspaceId: string, input: SetUpAiRequest, { actor }: { actor: ActorCtx }): Promise<SetUpAiResult> {
  await assertOwner(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AgentSessionError("invalid_runner", "the name must be 1–80 characters", 422);
  const connection: AiConnectionInput = input.connection;
  if (connection.kind === "api_new" && connection.protocol !== undefined && !isProtocolId(connection.protocol)) {
    throw new AgentSessionError("invalid_credential", "unknown format", 422);
  }
  // Everything that asks a service takes a while and writes nothing: it all happens HERE, before the transaction, so the
  // workspace's event lock is never held while waiting on someone else's server. Inside, only checks and writes remain.
  let detected: ProtocolId | null = null;
  let models: ApiModel[] | undefined;
  if (connection.kind === "api_new") {
    const baseUrl = normalizeBaseUrl(connection.base_url);
    const apiKey = connection.api_key.trim();
    detected = (connection.protocol as ProtocolId | undefined) ?? await detect(baseUrl, apiKey);
    models = await askService(detected, { baseUrl, apiKey });
  } else if (connection.kind === "api") {
    models = await listModels(workspaceId, connection.credential_id).catch(() => {
      throw new AgentSessionError("model_unavailable", "the model list could not be read with this key", 409);
    });
  }
  if (models && connection.kind !== "mcp") {
    const found = models.find((m) => m.id === connection.model);
    if (!found || found.lifecycle === "retired") throw new AgentSessionError("model_unavailable", "that model is not available for this key", 409);
  }

  return withEventTransaction(workspaceId, async () => {
    const owner = await resolveCurrentActor(actor, workspaceId);
    let credentialId: string | null = null;
    if (connection.kind === "api") credentialId = connection.credential_id;
    if (connection.kind === "api_new") {
      credentialId = (await addCredential(workspaceId, {
        label: connection.label, apiKey: connection.api_key, baseUrl: connection.base_url, protocol: detected!,
        inputPricePerM: connection.input_price_per_m, outputPricePerM: connection.output_price_per_m,
      }, { actor: owner })).id;
    }

    const created = await createActor(owner, async () => ({ name, type: "agent" }));
    const actorId = created.id as string;
    const handle = await freeHandle(workspaceId, input.handle?.trim().toLowerCase() || undefined);
    await configureRunner(workspaceId, actorId, { handle }, { actor: owner });
    if (connection.kind !== "mcp") {
      await setRoleRuntime(workspaceId, actorId, {
        defaultRuntime: "api", api: { credentialId: credentialId!, model: connection.model, cap: connection.cap, knownModels: models },
      }, { actor: owner });
    }
    const open = await sharedSpaceIdsWithCapability(workspaceId, "external_ai");
    for (const spaceId of open) await setMember(owner, workspaceId, spaceId, actorId, "edit");
    await setRunnerEnabled(workspaceId, actorId, true, { actor: owner });
    const minted = connection.kind === "mcp" ? await mintToken(owner, actorId, { name: connection.key_name?.trim() || name, access: "write" }) : null;
    return { actor_id: actorId, handle, credential_id: connection.kind === "api_new" ? credentialId : null, token: minted?.token ?? null, joined_space_ids: open };
  });
}
