// The HTTP error boundary — one mapping from thrown errors to API responses.
//
// A request that fails INPUT validation is the caller's fault and must read
// as 4xx, never 500: without this, every route that calls
// `schema.parse(await c.req.json())` bare turned a malformed body — empty
// title, limit: 0, truncated JSON — into Hono's default "Internal Server
// Error", which (a) lies to the client, (b) trips 5xx alerting for hostile-
// but-harmless input (found by src/test/boundarySweep.integration.test.ts).
//
// Spine errors map here too: UnauthorizedError → 401, AuthorityError /
// ScopeError → 403, body { error: <message> } — the exact response the
// per-route `catch { spineErrorStatus(e) … }` blocks used to build. That
// catch was copy-pasted ~55 times across route files for no behavioral gain;
// routes now just throw and this single handler answers. Catch blocks that do
// MORE than the mapping (cleanup, 409 detail payloads, batch skip-and-
// continue) survive in their routes and rethrow what they don't handle.
//
// Lives in its own module (not inline in index.ts) so test harnesses that
// assemble a Hono app from individual routers mount the SAME boundary the
// production app runs — a router test asserting 401/403 is asserting this
// mapping, never a copy of it.

import type { Context } from "hono";
import { z } from "zod";
import { log } from "./logger.js";
import { spineErrorStatus, IdempotentReplay, AuthorityError } from "./spine/mutate.js";
import { ScopeError } from "./spine/toolScope.js";
import { WorkspaceBusyError } from "./spine/eventLock.js";
import { RateLimitError } from "./services/agentTools/index.js";

import { NodeUpdateError } from "./services/nodeUpdate.js";
import { AgentRunError, RewindError } from "./services/history/index.js";
import { ModuleTagParentError, ParentKindError } from "./services/parentKind.js";
import { NodeTrashError } from "./services/nodeTrash.js";
import { BlockChildError } from "./services/blockChildNote.js";
import { SpaceMoveError } from "./services/spaces.js";
import { TagMembershipError } from "./services/tagMembershipWrites.js";
import { ModuleLibraryError, ModuleNotImportedError } from "./services/workspaceModules.js";
import { AttributeWriteError } from "./services/attributeWrites.js";
import { TagMergeError } from "./services/tagMerge.js";
import { ReservedTagError } from "./services/reservedTags.js";
import { TagViewNameConflictError } from "./services/tagViews.js";
import { ViewModuleTagError } from "./services/viewModules.js";
import { isTagNameConflict, TagCreateRefusal, TagNameConflictError, TagNameShapeError } from "./services/tagHierarchy.js";
import { ChromeStale } from "./services/siteConfig.js";
import { DerivedEdgeError } from "./services/edgeWrites.js";
import { CodedStatusError, StatusError } from "./statusError.js";
import { InvalidFieldError } from "./services/fieldSchema.js";
import { NoteSizeError } from "./services/noteSize.js";
import { FieldNameClashError } from "./services/tagFields.js";
import { BackupFileError, BackupRestoreRefusal, BackupUploadNotFound } from "./services/backupFile.js";
import { InviteError } from "./services/actorInvites.js";
import { AgentSessionError } from "./services/agentSessionError.js";

export function apiOnError(err: Error, c: Context): Response {
  // Idempotent replay is a SUCCESS, not an error: the original write already
  // committed, so re-running is a no-op. The claim now lives inside the route's
  // transaction (spine mutate()), so reaching here means the prior attempt
  // genuinely committed — never the old bug where a rolled-back write left a
  // committed key behind and a retry was wrongly short-circuited.
  if (err instanceof IdempotentReplay) {
    return c.json({ deduped: true }, 200);
  }
  // Per-actor metering (agent tools, the AI endpoints): one 429 envelope.
  if (err instanceof RateLimitError) {
    c.header("Retry-After", String(err.retryAfterSeconds));
    return c.json({ error: "rate_limited", detail: err.message, retry_after_seconds: err.retryAfterSeconds }, 429);
  }
  // Another write held the workspace lock past its wait limit: nothing was written, send it again.
  if (err instanceof WorkspaceBusyError) {
    c.header("Retry-After", String(err.retryAfterSeconds));
    return c.json({ error: err.code, retry_after_seconds: err.retryAfterSeconds }, 503);
  }
  const s = spineErrorStatus(err);
  if (s) {
    return c.json({ error: err.message || (s === 401 ? "unauthorized" : "forbidden") }, s);
  }
  if (err instanceof AgentSessionError) return c.json({ error: err.code, detail: err.message }, err.status);
  if (err instanceof BlockChildError) return c.json({ error: err.code, ...err.detail }, err.status);
  if (err instanceof NodeUpdateError) {
    return c.json(err.code ? { error: err.code, detail: err.message } : { error: err.message }, err.status);
  }
  if (err instanceof AgentRunError) return c.json({ error: err.message }, err.status);
  if (err instanceof RewindError) return c.json({ error: err.code }, err.status);
  if (err instanceof ParentKindError) return c.json({ error: err.code, detail: err.message }, 409);
  if (err instanceof ModuleTagParentError) return c.json({ error: err.code, detail: err.message }, 409);
  if (err instanceof NodeTrashError) {
    return c.json(err.code ? { error: err.code, detail: err.message } : { error: err.message }, err.status);
  }
  if (err instanceof NoteSizeError) return c.json({ error: err.code, detail: err.message }, err.status);
  if (err instanceof SpaceMoveError) return c.json({ error: err.code, detail: err.message }, err.status);
  if (err instanceof TagMembershipError) return c.json({ error: err.message }, err.status);
  if (err instanceof CodedStatusError) return c.json({ error: err.code, detail: err.message }, err.status);
  if (err instanceof StatusError) return c.json({ error: err.message }, err.status);
  if (err instanceof ModuleLibraryError) return c.json({ error: err.message }, err.status);
  // A patch whose base this server cannot give back: the writer sends the whole value (lib/data/patchedBody.ts).
  if (err instanceof ChromeStale) return c.json({ error: err.code, detail: err.message }, 409);
  if (err instanceof DerivedEdgeError) return c.json({ error: err.code, detail: err.message }, 409);
  if (err instanceof ViewModuleTagError) return c.json({ error: err.code, detail: err.message, module: err.module }, 409);
  if (err instanceof FieldNameClashError) return c.json({ error: err.code, detail: err.message, clashes: err.clashes }, 409);
  if (err instanceof ModuleNotImportedError) return c.json({ error: err.code, module: err.module }, 409);
  if (err instanceof AttributeWriteError) {
    return c.json(err.detail === undefined ? { error: err.code } : { error: err.code, detail: err.detail }, err.status);
  }
  if (err instanceof InvalidFieldError) return c.json({ error: "invalid_field", problems: err.problems }, 400);
  if (err instanceof TagMergeError) return c.json(err.body, err.status);
  if (err instanceof ReservedTagError) return c.json(err.body, err.status);
  if (err instanceof TagViewNameConflictError) return c.json({ error: "name_collision", detail: err.message }, 409);
  if (err instanceof TagCreateRefusal) return c.json({ error: err.code, detail: err.message }, 409);
  if (err instanceof TagNameShapeError) return c.json({ error: "tag_name_invalid", detail: err.message }, 400);
  if (err instanceof InviteError) return c.json({ error: err.code }, err.status);
  if (err instanceof BackupFileError) return c.json({ error: err.code, entry: err.entry }, err.status);
  if (err instanceof BackupUploadNotFound) return c.json({ error: "upload_not_found" }, 404);
  if (err instanceof BackupRestoreRefusal) return c.json({ error: err.code }, err.status);
  if (isTagNameConflict(err)) {
    return c.json({ error: "tag_name_conflict", detail: new TagNameConflictError().message }, 409);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: "bad_request", detail: err.issues }, 400);
  }
  // c.req.json() on a malformed body throws SyntaxError.
  if (err instanceof SyntaxError) {
    return c.json({ error: "bad_request", detail: "malformed JSON body" }, 400);
  }
  log.error("unhandled", "unhandled route error", { err });
  return c.json({ error: "internal" }, 500);
}

/** The agent-tool surface (routes/mcp.ts). Its clients read a machine code in
 *  `error` — the authority reason (`tag_not_allowed`), the scope code
 *  (`tool_not_allowed`), `invalid_args` — where the app's routes answer with
 *  the message the frontend translates. Everything else is apiOnError's. */
export function toolOnError(err: Error, c: Context): Response {
  if (err instanceof ScopeError) return c.json({ error: err.code, detail: err.message }, 403);
  if (err instanceof AuthorityError) return c.json({ error: err.reason, detail: err.message }, 403);
  if (err instanceof z.ZodError) return c.json({ error: "invalid_args", detail: err.issues }, 400);
  return apiOnError(err, c);
}
