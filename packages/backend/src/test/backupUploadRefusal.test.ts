// POST /api/backup/restore/upload sits behind an nginx that passes the body through unbuffered, so a refusal must
// come before the body is read: not a signed-in person, a declared length over the cap, no room on the disk.
// A body that counts the bytes pulled from it proves it. No database: the route's person check and staging only.

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import backup from "../routes/backup.js";
import type { ActorCtx } from "../types.js";

const MB = 1024 * 1024;

function countingBody(chunks: number, chunkBytes: number): { body: ReadableStream<Uint8Array>; read: () => number } {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) { controller.close(); return; }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  }, { highWaterMark: 0 });
  return { body, read: () => sent };
}

function appAs(actor: ActorCtx | null) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/backup", backup);
  return app;
}

async function upload(actor: ActorCtx | null, declared: number | null) {
  const { body, read } = countingBody(8, MB);
  const headers: Record<string, string> = declared === null ? {} : { "content-length": String(declared) };
  const res = await appAs(actor).request("/api/backup/restore/upload", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { res, read };
}

afterEach(() => { delete process.env.ONDEN_MAX_BACKUP_MB; });

describe("backup restore upload refuses before reading the body", () => {
  it("reads nothing for a caller who is not signed in", async () => {
    const { res, read } = await upload(null, 8 * MB);
    expect([401, 403]).toContain(res.status);
    expect(res.headers.get("connection")).toBe("close");
    expect(read()).toBe(0);
  });

  it("reads nothing for a delegated token, which never restores a workspace", async () => {
    const { res, read } = await upload({ id: "token-actor", name: "agent", type: "agent", tokenScope: { tokenId: "t", allowedTools: null } } as unknown as ActorCtx, 8 * MB);
    expect(res.status).toBe(403);
    expect(read()).toBe(0);
  });

  it("reads nothing when the stated length is over the cap", async () => {
    process.env.ONDEN_MAX_BACKUP_MB = "5";
    const { res, read } = await upload({ id: "a-person", name: "p", type: "human" } as ActorCtx, 6 * MB);
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(read()).toBe(0);
  });
});
