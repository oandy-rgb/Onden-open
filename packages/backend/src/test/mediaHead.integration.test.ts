// HEAD /api/media/:file answers size and type without opening the file. Hono
// runs the GET handler for a HEAD and throws the body away without cancelling
// its stream, so a stream opened for it would leave the file open — and the
// podcast feed sends one HEAD per audio file on every fetch.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return { ...real, createReadStream: ((...args: Parameters<typeof real.createReadStream>) => { opened.count++; return real.createReadStream(...args); }) as typeof real.createReadStream };
});

import { apiOnError } from "../httpError.js";
import { getWorkspaceId } from "../db.js";
import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

let actor: ActorCtx = { id: "", name: "Reader", type: "human", role: "editor" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/media", mediaRouter);

describe.skipIf(!isTestDatabase())("HEAD /api/media/:file", () => {
  const name = `${randomBytes(16).toString("hex")}.mp3`;
  const path = join(MEDIA_DIR, name);
  beforeAll(async () => {
    actor = await persistActor(await getWorkspaceId(), actor);
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(path, Buffer.alloc(1234));
  });
  afterAll(() => rmSync(path, { force: true }));

  it("answers size and type, and opens no file", async () => {
    opened.count = 0;
    const res = await app.request(`/api/media/${name}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1234");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(opened.count).toBe(0);
  });

  it("a GET still streams the file", async () => {
    opened.count = 0;
    const res = await app.request(`/api/media/${name}`);
    expect((await res.arrayBuffer()).byteLength).toBe(1234);
    expect(opened.count).toBe(1);
  });
});
