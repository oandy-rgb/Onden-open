// T10 (user decision 2026-10-16): a `#word` written in a note's text is not
// a tag. The published payload's `tags` (attachPublishedTags) lists the
// note's stored label tags only — a body `#foo` adds nothing, even when a tag
// named foo exists.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { attachPublishedTags } from "../modules/website/publishing/redaction.js";
import nodes from "../routes/nodes.js";
import tags from "../routes/tags.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const admin: ActorCtx = { id: "published-tags-admin", name: "Test", type: "human", role: "admin" };
const ids: string[] = [];

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => {
  c.set("actor", admin);
  await withIdempotencyKey(randomUUID(), next);
});
app.route("/api/nodes", nodes);
app.route("/api/tags", tags);

const send = (method: string, path: string, body: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function created(response: Response): Promise<string> {
  expect(response.status).toBeLessThan(300);
  const { id } = await response.json() as { id: string };
  ids.push(id);
  return id;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("published tags are stored tags only (T10)", () => {
  beforeAll(async () => {
    const ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => {
    await awaitAllDispatchers();
    await seedQ("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [ids]);
  });

  it("a body #name is not listed; a tag applied to the note is", async () => {
    const name = `t10-${randomUUID().slice(0, 8)}`;
    const tagId = await created(await send("POST", "/api/tags", { name }));
    const textOnly = await created(await send("POST", "/api/nodes", { title: "Text only", markdown: `Body says #${name} and #nosuchtag` }));
    const tagged = await created(await send("POST", "/api/nodes", { title: "Tagged", markdown: "No hashtags here" }));
    expect((await send("PUT", `/api/nodes/${tagged}/tags/${tagId}`, {})).status).toBeLessThan(300);

    const payload: Array<{ id: string; tags?: string[] }> = [{ id: textOnly }, { id: tagged }];
    await attachPublishedTags(payload);
    expect(payload[0]!.tags).toEqual([]);
    expect(payload[1]!.tags).toEqual([name]);
  });

  it("a tag with fields is listed too, so its date rule and chip reach the site", async () => {
    const name = `t10-fields-${randomUUID().slice(0, 8)}`;
    const tagId = await created(await send("POST", "/api/tags", { name }));
    await seedQ(`UPDATE content_nodes SET tag_schema = '{"fields":[{"key":"source","type":"text"}]}'::jsonb WHERE id = $1`, [tagId]);
    const tagged = await created(await send("POST", "/api/nodes", { title: "Article", markdown: "Body" }));
    expect((await send("PUT", `/api/nodes/${tagged}/tags/${tagId}`, {})).status).toBeLessThan(300);

    const payload: Array<{ id: string; tags?: string[] }> = [{ id: tagged }];
    await attachPublishedTags(payload);
    expect(payload[0]!.tags).toEqual([name]);
  });
});
