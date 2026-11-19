// Guard: the app's watermark (frontend lib/data/writePositions.ts) is keyed by the server identity alone, while
// domain_events.id is one sequence for every workspace and each answer's head is its workspace's MAX(id)
// (services/sync/delta.ts workspaceHead). That holds because a server serves one workspace: every route takes it from
// getWorkspaceId(), which reads nothing of the request. The day the workspace comes from the session, positions of one
// workspace would be compared with heads of another, and a healthy server would be taken for one that went back — this
// turns red then: key the watermark by workspace as well, and change it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { code, SRC } from "./nodeStoreOwnershipScan.js";

describe("one workspace per server (the watermark's premise)", () => {
  it("getWorkspaceId takes nothing from the request", () => {
    const db = code(readFileSync(join(SRC, "db.ts"), "utf8"));
    expect(db, "getWorkspaceId now takes an argument: the workspace may differ per request").toMatch(/export async function getWorkspaceId\(\s*\)/);
    // Its body reads one fixed row: no query parameter, nothing of the request's context (the actor, a store, a header).
    const start = db.indexOf("export async function getWorkspaceId(");
    const body = db.slice(start, db.indexOf("\n}\n", start));
    expect(body, "getWorkspaceId reads something else than the one default workspace").toMatch(/q<\{ id: string \}>\(\s*"SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1",?\s*\)/);
    expect(body).not.toMatch(/getStore|AsyncLocalStorage|actor|header|context|\bc\.|process\.env/);
    const entry = code(readFileSync(join(SRC, "services/workspaceId.ts"), "utf8"));
    expect(entry).toMatch(/export \{ getWorkspaceId \} from "\.\.\/db\.js"/);
  });
});
