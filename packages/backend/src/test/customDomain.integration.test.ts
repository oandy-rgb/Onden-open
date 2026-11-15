// The in-UI custom domain: a domain set in siteConfig produces a CNAME file
// that PERSISTS (cnameFile reads live config, so it re-applies on every
// push), and a malformed domain emits no CNAME.
//
// SAFETY: only runs against a *_test database (describe.skipIf).

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { cnameFile, normalizeCustomDomain } from "../modules/website/publishing/cname.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// Its own workspace: the shared 'default' one holds other files' settings.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

describe.skipIf(!isTestDb)("custom domain → CNAME file", () => {
  let workspaceId: string;

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Site test', $1) RETURNING id`, [randomUUID()],
    );
    workspaceId = ownWorkspace = ws.rows[0]!.id;
  });

  it("persistent CNAME file (live config, malformed rejected)", async () => {
    // pure normalizer
    expect(normalizeCustomDomain("https://Blog.Example.com/path")).toBe("blog.example.com");
    expect(normalizeCustomDomain("not a domain")).toBeNull();
    expect(normalizeCustomDomain("")).toBeNull();

    // no domain configured → no CNAME
    await setSiteConfig(workspaceId, { custom_domain: "" });
    expect(await cnameFile(workspaceId)).toBeNull();

    // configured → a CNAME the pages-push will emit; reads LIVE config so it
    // re-applies on every push (persists across re-deploys).
    await setSiteConfig(workspaceId, { custom_domain: "blog.example.com" });
    expect(await cnameFile(workspaceId)).toEqual({ path: "CNAME", content: "blog.example.com\n" });
  });
});
