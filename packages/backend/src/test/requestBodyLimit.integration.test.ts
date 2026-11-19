// A person's request has NO body size limit in the backend itself (found in review round 3 of the temporary-sessions PR; docs/architecture/proposals/sessions-reads-own-2026-11-17.md §6).
//
// Only the proxy in front of it limits a body: docker/nginx/nginx.conf `client_max_body_size` 20m on /api/ and 501m on /api/media. A connection made directly to the backend (a node that
// is not behind that proxy, a misconfigured proxy, another process on the machine) can send any size to any route of a signed-in person, and the backend reads it whole before it
// answers. NOT CHANGED here on purpose (a limit changes what every route accepts): this test PINS today's behaviour, so whoever adds the limit has to change it, and says so.
// A temporary session is different: its bodies are limited in the backend (services/participantSessions.ts readTemporarySessionBody; participantSessions.integration.test.ts).
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MAX_REQUEST_BYTES } from "@onden/markdown";
import { pool } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { standardWorld } from "./helpers/sessionWorld.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@body-limit.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

const SRC = join(import.meta.dirname, "..");
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
  return name.endsWith(".ts") ? [path] : [];
});

describe.skipIf(!isTestDatabase())("the backend itself does not limit the size of a person's request (only the proxy does)", () => {
  let ownerExt = "";
  beforeAll(async () => {
    const w = await standardWorld("body-limit");
    ownWorkspace = w.ws;
    ownerExt = w.owner.ext;
  });
  afterAll(async () => { await pool.end(); });

  it("a body past the proxy's 20 MiB is read whole and judged by the route (400 for a value of the wrong shape), not refused for its size (413)", async () => {
    signedInAs = ownerExt;
    try {
      const filler = "x".repeat(1024);
      const items = JSON.stringify(Array.from({ length: Math.ceil((MAX_REQUEST_BYTES + 1024 * 1024) / (filler.length + 3)) }, () => filler));
      const body = `{"value":${items}}`;
      expect(body.length).toBeGreaterThan(MAX_REQUEST_BYTES); // over what the proxy lets through (docker/nginx/nginx.conf: client_max_body_size 20m)
      const res = await app.request("/api/me/prefs/hintsSeen", { method: "PUT", headers: { "content-type": "application/json" }, body });
      // WHEN SOMEONE ADDS A BODY LIMIT TO THE BACKEND this becomes 413: change this line and docs/architecture/proposals/sessions-reads-own-2026-11-17.md §6 with it.
      expect(res.status).toBe(400);
      expect(JSON.parse(await res.text()).error).toBe("invalid_pref");
    } finally { signedInAs = null; }
  }, 120_000);

  it("only the upload route has a limit of its own in the backend (a bodyLimit( call)", () => {
    const users = sourceFiles(SRC).filter((file) => /\bbodyLimit\(/.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file).split("\\").join("/"));
    expect(users).toEqual(["routes/media.ts"]);
  });
});
