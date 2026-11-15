// Group C — Obsidian import attachment landing: authority is enforced BEFORE the
// image loop writes attacker-controlled bytes to MEDIA_DIR. Pre-fix the auth
// check ran AFTER Phase-1 disk writes (and without the upload route's svg
// sanitize / byte cap), so a read-only viewer could land an unsanitized,
// unbounded file on a public path. These assertions decide in the route BEFORE
// any DB work (the gate throws at assertAuthority), so they run offline.
//
// The svg-sanitize and byte-cap of an ACCEPTED (editor) import reuse the exact
// helpers the upload route uses (sanitizeSvg, capFor), which carry their own
// unit coverage (svgSanitize.test.ts); the load-bearing NEW guarantee here is
// "nothing lands on disk before the authority gate", proved below.
//
// Under spaces the gate asks whether the actor can write in some space (a
// viewer still writes in their own personal space). The DB answer is stubbed
// to "no space" so the test stays offline.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, readdirSync } from "node:fs";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import type { ActorCtx } from "../types.js";

vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  q: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

// An actor who can write in no space (e.g. an agent added to none).
const viewer: ActorCtx = { id: "imp-viewer", name: "Viewer", role: "viewer", type: "human" };

function appFor(actor: ActorCtx | null) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/import", importRouter);
  return app;
}

function mediaDirSnapshot(): Set<string> {
  return new Set(existsSync(MEDIA_DIR) ? readdirSync(MEDIA_DIR) : []);
}

function newFiles(before: Set<string>): string[] {
  return [...mediaDirSnapshot()].filter((f) => !before.has(f));
}

// A tiny SVG carrying an inline <script> — the stored-XSS payload an import must
// never land unsanitized (and a viewer must never land at all).
const EVIL_SVG_B64 = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
).toString("base64");

const post = (app: Hono<{ Variables: { actor: ActorCtx | null } }>, body: unknown) =>
  app.request("/api/import/obsidian", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("import attachment authority gate (pre-disk, offline)", () => {
  it("an actor who can write in no space is rejected (403) BEFORE any image lands on disk", async () => {
    const before = mediaDirSnapshot();
    const res = await post(appFor(viewer), { files: [{ path: "evil.svg", base64: EVIL_SVG_B64 }] });
    expect(res.status).toBe(403);
    expect(newFiles(before), "viewer import must not write to MEDIA_DIR").toEqual([]);
  });

  it("an unauthenticated import is rejected (401), nothing on disk", async () => {
    const before = mediaDirSnapshot();
    const res = await post(appFor(null), { files: [{ path: "x.png", base64: "AAAAAAAA" }] });
    expect(res.status).toBe(401);
    expect(newFiles(before), "anonymous import must not write to MEDIA_DIR").toEqual([]);
  });
});
