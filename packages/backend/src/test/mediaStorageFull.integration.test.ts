// An upload the storage has no room for (the browser app's quota; a full disk): the person is told (507
// insufficient_storage), nothing is kept — no file, no uploader record — and the notes are not touched.
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import sharp from "sharp";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, q } from "../db.js";
import mediaRouter from "../routes/media.js";
import { diskMediaFiles, MediaStorageFull, useMediaFiles, type MediaFiles } from "../services/mediaFiles.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

let actor: ActorCtx = { id: "", name: "Uploader", type: "human", role: "editor" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/media", mediaRouter);

const full: MediaFiles = {
  ...diskMediaFiles(),
  write: () => Promise.reject(new MediaStorageFull()),
};

describe.skipIf(!isTestDatabase())("POST /api/media when the storage is full", () => {
  beforeAll(async () => { actor = await persistActor(await getWorkspaceId(), actor); });
  afterAll(() => useMediaFiles(diskMediaFiles()));

  it("answers 507 insufficient_storage and keeps neither a file nor an uploader record", async () => {
    useMediaFiles(full);
    const before = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM media_uploads`)).rows[0]!.n);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#369" } }).png().toBuffer();
    const form = new FormData();
    form.append("file", new File([new Uint8Array(png)], "photo.png"));
    const res = await app.request("/api/media", { method: "POST", body: form });
    expect(res.status).toBe(507);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_storage");
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM media_uploads`)).rows[0]!.n)).toBe(before);
  });
});
