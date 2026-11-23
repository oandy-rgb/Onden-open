import { Hono } from "hono";
import { holdOpenStream } from "./sseStream.js";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import { assertMayReachOut } from "../spine/authority.js";
import { addCredentialDetectingFormat, testCredential, testStoredCredential } from "../services/aiCredentialSetup.js";
import { setUpAi } from "../services/aiSetup.js";
import { listCredentials, revokeCredential } from "../services/aiCredentials.js";
import { secretKeyConfigured } from "../services/serverSecret.js";
import { patchRole, roleRuntimes, setRoleRuntime } from "../services/aiRoles.js";
import { startSelectionAction } from "../services/selectionActions.js";
import { handToAiOptions } from "../services/handToAi.js";
import { loadSession, sessionView } from "../services/agentSessions.js";
import { AgentSessionError } from "../services/agentSessionError.js";
import { followPreview, isRuntimeKind, listModels, type LiveEvent, type RuntimeKind } from "../services/agentRuntime/index.js";
import { isProtocolId, type ProtocolId } from "../services/agentRuntime/index.js";
import { parseBody, uuidParam, uuidQuery } from "./params.js";
import { AI_NAME_MAX } from "@onden/markdown";

// Settings for the `api` AI runtime and the small-action entry point. Who may do
// what (workspace owner for keys and roles, a person for actions) is decided in the
// services; the keys themselves never leave them — only label and last four characters.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();
const UUID = z.string().uuid();

// GET /api/ai/status — whether the API way of running exists on this server at all:
// it can keep keys (ONDEN_SECRET_KEY). Without it no API setting is shown anywhere.
router.get("/status", (c) => {
  requireActor(c.get("actor"));
  return c.json({ api_runtime_offered: secretKeyConfigured() });
});

router.get("/credentials", async (c) =>
  c.json({ credentials: await listCredentials(await getWorkspaceId(), { actor: requireActor(c.get("actor")) }) }));

// `protocol` is sent only when the format could not be detected and the person chose it (409-like 422 protocol_undetected).
// The prices are the person's own, USD per million tokens; blank = tokens only.
const CredentialBody = z.object({
  label: z.string().min(1).max(AI_NAME_MAX),
  api_key: z.string().min(8).max(500), base_url: z.string().min(1).max(500),
  protocol: z.string().refine(isProtocolId).optional(),
  input_price_per_m: z.number().min(0).max(1_000_000).nullable().optional(), output_price_per_m: z.number().min(0).max(1_000_000).nullable().optional(),
});
router.post("/credentials", async (c) => {
  assertMayReachOut(requireActor(c.get("actor"))); // the key is tried against its provider
  const body = await parseBody(c, CredentialBody);
  const credential = await addCredentialDetectingFormat(await getWorkspaceId(), {
    label: body.label, apiKey: body.api_key, baseUrl: body.base_url, protocol: body.protocol as ProtocolId | undefined,
    inputPricePerM: body.input_price_per_m, outputPricePerM: body.output_price_per_m,
  }, { actor: requireActor(c.get("actor")) });
  return c.json({ credential }, 201);
});

// POST /api/ai/credentials/test — ask the service with this key and save nothing: the format it speaks
// and the models it lists. 422 credential_rejected / service_unreachable / protocol_undetected, like adding the key.
const TestBody = z.object({ base_url: z.string().min(1).max(500), api_key: z.string().min(8).max(500), protocol: z.string().refine(isProtocolId).optional() });
router.post("/credentials/test", async (c) => {
  assertMayReachOut(requireActor(c.get("actor")));
  const body = await parseBody(c, TestBody);
  const result = await testCredential({ apiKey: body.api_key, baseUrl: body.base_url, protocol: body.protocol as ProtocolId | undefined }, { actor: requireActor(c.get("actor")) });
  return c.json({ ok: true, protocol: result.protocol, models: result.models });
});

// POST /api/ai/credentials/:id/test — the same, for a key that is kept.
router.post("/credentials/:id/test", async (c) => {
  assertMayReachOut(requireActor(c.get("actor")));
  const result = await testStoredCredential(await getWorkspaceId(), uuidParam(c, "id"), { actor: requireActor(c.get("actor")) });
  return c.json({ ok: true, protocol: result.protocol, models: result.models });
});

router.delete("/credentials/:id", async (c) =>
  c.json({ credential: await revokeCredential(await getWorkspaceId(), uuidParam(c, "id"), { actor: requireActor(c.get("actor")) }) }));

// The models this key can use, asked of the key itself. Owner only.
router.get("/credentials/:id/models", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  assertMayReachOut(actor);
  const id = uuidParam(c, "id");
  await listCredentials(workspaceId, { actor }); // owner check
  try {
    return c.json({ models: await listModels(workspaceId, id) });
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError("model_unavailable", "the model list could not be read with this key", 409);
  }
});

router.get("/roles", async (c) =>
  c.json({ roles: await roleRuntimes(await getWorkspaceId(), { actor: requireActor(c.get("actor")) }) }));

// POST /api/ai/roles — a new AI with everything it needs, in one step (services/aiSetup.ts).
const CapBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unlimited") }),
  z.object({ kind: z.literal("capped"), tokens: z.number().int().positive().max(1e12) }),
]);
const SetUpBody = z.object({
  name: z.string().min(1).max(AI_NAME_MAX),
  handle: z.string().max(64).optional(),
  connection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("api"), credential_id: UUID, model: z.string().min(1).max(200), cap: CapBody }),
    z.object({
      kind: z.literal("api_new"), label: z.string().min(1).max(AI_NAME_MAX),
      api_key: z.string().min(8).max(500), base_url: z.string().min(1).max(500),
      protocol: z.string().refine(isProtocolId).optional(),
      input_price_per_m: z.number().min(0).max(1_000_000).nullable().optional(), output_price_per_m: z.number().min(0).max(1_000_000).nullable().optional(),
      model: z.string().min(1).max(200), cap: CapBody,
    }),
    z.object({ kind: z.literal("mcp"), key_name: z.string().max(AI_NAME_MAX).optional() }),
  ]),
});
router.post("/roles", async (c) => {
  assertMayReachOut(requireActor(c.get("actor")));
  const body = await parseBody(c, SetUpBody);
  return c.json(await setUpAi(await getWorkspaceId(), body, { actor: requireActor(c.get("actor")) }), 201);
});

const RuntimeBody = z.object({
  default_runtime: z.string().refine(isRuntimeKind).optional(),
  api: z.object({
    credential_id: UUID.optional(),
    model: z.string().min(1).max(200).optional(),
    small_actions_only: z.boolean().optional(),
    web_search: z.boolean().optional(),
    cap: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("unlimited") }),
      z.object({ kind: z.literal("capped"), tokens: z.number().int().positive().max(1e12) }),
    ]).optional(),
  }).optional(),
});
router.put("/roles/:actor_id/runtime", async (c) => {
  assertMayReachOut(requireActor(c.get("actor")));
  const body = await parseBody(c, RuntimeBody);
  const runner = await setRoleRuntime(await getWorkspaceId(), uuidParam(c, "actor_id"), {
    defaultRuntime: body.default_runtime as never,
    api: body.api && {
      credentialId: body.api.credential_id, model: body.api.model, smallActionsOnly: body.api.small_actions_only,
      webSearch: body.api.web_search, cap: body.api.cap,
    },
  }, { actor: requireActor(c.get("actor")) });
  return c.json({ default_runtime: runner.default_runtime });
});

// PATCH /api/ai/roles/:actor_id — the role-level switches: how its edits take effect
// (review_rule), which way it runs by default, paused or not. Owner only, never a token.
const RolePatchBody = z.object({
  review_rule: z.enum(["suggest", "apply"]).optional(),
  default_runtime: z.string().refine(isRuntimeKind).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "nothing to change");
router.patch("/roles/:actor_id", async (c) => {
  const actor = requireActor(c.get("actor"));
  assertMayReachOut(actor);
  const agentActorId = uuidParam(c, "actor_id");
  const body = await parseBody(c, RolePatchBody);
  await patchRole(await getWorkspaceId(), agentActorId, {
    reviewRule: body.review_rule, defaultRuntime: body.default_runtime as never, enabled: body.enabled,
  }, { actor });
  const role = (await roleRuntimes(await getWorkspaceId(), { actor })).find((r) => r.actor_id === agentActorId);
  return c.json({ role });
});

const SelectionBody = z.object({
  agent_actor_id: UUID, node_id: UUID, skill: z.string().min(1).max(64),
  text: z.string().min(1).max(20_000), instruction: z.string().max(1_000).optional(), request_id: UUID,
  /** The way of running for this one action; without it the role's default. */
  runtime: z.string().refine(isRuntimeKind).optional(),
});
// POST /api/ai/selection-actions — 201 new, 200 the session this request_id already made.
router.post("/selection-actions", async (c) => {
  const body = await parseBody(c, SelectionBody);
  const { sessionId, created } = await startSelectionAction(await getWorkspaceId(), {
    actor: requireActor(c.get("actor")), agentActorId: body.agent_actor_id, nodeId: body.node_id,
    skill: body.skill, text: body.text, instruction: body.instruction, requestId: body.request_id,
    runtime: body.runtime as RuntimeKind | undefined,
  });
  return c.json({ session_id: sessionId, created }, created ? 201 : 200);
});

// GET /api/ai/hand-to-ai?node_id= — who can take a selection or paragraph of this note, and how.
router.get("/hand-to-ai", async (c) =>
  c.json(await handToAiOptions(await getWorkspaceId(), uuidQuery(c, "node_id"), { actor: requireActor(c.get("actor")) })));

// GET /api/ai/selection-actions/:id/stream — the answer as it is written (api runtime), then
// one `end` frame with how the session ended. A preview only: the suggestion is made from the
// finished text. Frames: {kind:"text", text:<delta>} … {kind:"step", what, title} (an info-panel turn: what the AI is
// reading or searching) … {kind:"end", status, fail_code}.
// Only the sender or the owner (sessionView says not_found to anyone else).
router.get("/selection-actions/:id/stream", async (c) => {
  const sessionId = uuidParam(c, "id");
  await sessionView(sessionId, { actor: requireActor(c.get("actor")) });
  return holdOpenStream(c, async ({ stream, close, isClosed, onClose }) => {
    let chain = Promise.resolve();
    const send = (frame: object) => { chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(frame) })).catch(() => close()); };
    const sendEnd = async () => {
      const now = await loadSession(sessionId);
      send({ kind: "end", status: now?.status ?? "failed", fail_code: now?.fail_code ?? null });
      chain = chain.then(close);
    };
    const onEvent = (event: LiveEvent) => {
      if (event.kind === "text") send({ kind: "text", text: event.text });
      else if (event.kind === "step") send({ kind: "step", ...event.step });
      else if (event.kind === "restart") send({ kind: "restart" });
      else void sendEnd();
    };
    // The run starts when the outbox hands it over, a moment after the request returned: wait for it
    // (a few seconds at most) unless the session has already ended.
    let live = followPreview(sessionId, onEvent);
    for (let waited = 0; !live && !isClosed() && waited < 20; waited++) {
      const now = await loadSession(sessionId);
      if (!now || !["queued", "running"].includes(now.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      live = followPreview(sessionId, onEvent);
    }
    if (live) {
      onClose(live.stop);
      if (live.step) send({ kind: "step", ...live.step });
      if (live.text) send({ kind: "text", text: live.text });
      if (live.ended) void sendEnd();
    } else {
      // Not running in this process (finished, a runner's, or not started yet): no live text, only how it stands.
      void sendEnd();
    }
  });
});

export default router;
