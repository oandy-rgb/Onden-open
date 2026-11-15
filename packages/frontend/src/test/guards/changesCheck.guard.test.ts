// `npm run changes:check` (scripts/changes.mjs): touching code users can see needs a changes/*.md.
import { describe, expect, it } from "vitest";
import { checkChanges, isUserFacingSource, skipRequested } from "../../../../../scripts/changesLib.mjs";

const mod = (path: string) => ({ status: "M", path });

describe("checkChanges", () => {
  it("asks for a changes/ file when frontend or site code changed without one", () => {
    const r = checkChanges([mod("packages/frontend/src/components/DeviceNotices.tsx")]);
    expect(r.ok).toBe(false);
    expect(r.touched).toEqual(["packages/frontend/src/components/DeviceNotices.tsx"]);
    expect(checkChanges([mod("packages/site/src/index.ts")]).ok).toBe(false);
  });
  it("passes once a new changes/*.md is added (the README does not count)", () => {
    const code = mod("packages/frontend/src/lib/x.ts");
    expect(checkChanges([code, { status: "A", path: "changes/2026-10-29-x.md" }]).ok).toBe(true);
    expect(checkChanges([code, { status: "A", path: "changes/README.md" }]).ok).toBe(false);
    expect(checkChanges([code, mod("changes/2026-10-29-x.md")]).ok).toBe(false);
  });
  it("ignores tests, backend, docs and deleted files", () => {
    for (const path of [
      "packages/frontend/src/test/foo.test.tsx", "packages/frontend/src/lib/foo.test.ts", "packages/frontend/src/test/guards/a.guard.test.ts",
      "packages/backend/src/routes/x.ts", "docs/deploy-log.md", "scripts/changes.mjs",
    ]) expect(isUserFacingSource(path), path).toBe(false);
    expect(checkChanges([{ status: "D", path: "packages/frontend/src/lib/old.ts" }]).ok).toBe(true);
  });
});

describe("skipRequested", () => {
  it("is the flag, CHANGES_SKIP=1, or the phrase in the PR text", () => {
    expect(skipRequested(["--skip"], {})).toBe(true);
    expect(skipRequested([], { CHANGES_SKIP: "1" })).toBe(true);
    expect(skipRequested([], { PR_BODY: "只改內部。不需要更新說明" })).toBe(true);
    expect(skipRequested([], { PR_BODY: "加了新功能" })).toBe(false);
    expect(skipRequested([], {})).toBe(false);
  });
});
