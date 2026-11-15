// The baseline of accessibility violations that exist on main.
//
// Each guard in this folder finds violations as stable string ids and passes
// them to `guardAgainstNewViolations`, which does two things:
//   - a test that fails when a violation appears that is not listed here, and
//   - one `it.fails` per listed violation. It passes while the violation is
//     still there and turns red the moment it is fixed, so the fix removes
//     its line here. The list can only shrink.
//
// Entry: id → why it is accepted for now. A reason that names a PR means that
// PR fixes it; when the PR merges the entry flips and is deleted.
import { beforeAll, describe, expect, it } from "vitest";

export type Baseline = Readonly<Record<string, string>>;

/** `found` may be async (axe is); it runs once, before the first test of the group. */
// `found` scans the whole source (the dialogs guard parses every component with the TypeScript
// parser: about 3 s alone on the laptop), so its time grows with the code and with how busy the
// machine is. In the full suite, four workers at once, it passed vitest's 5 s hook limit now and
// then (2026-11-12). The limit is there to catch a hang, not to time the scan.
const SCAN_TIMEOUT_MS = 60_000;

export function guardAgainstNewViolations(title: string, found: () => string[] | Promise<string[]>, baseline: Baseline, timeoutMs = SCAN_TIMEOUT_MS): void {
  describe(title, () => {
    let violations: string[] = [];
    beforeAll(async () => { violations = await found(); }, timeoutMs);
    it("has no violation outside the baseline", () => {
      expect(violations.filter((id) => !(id in baseline))).toEqual([]);
    });
    for (const [id, reason] of Object.entries(baseline)) {
      it.fails(`${id} (${reason})`, () => {
        expect(violations).not.toContain(id);
      });
    }
  });
}


// ── static guards (staticGuards.test.ts) ────────────────────────────────────

// ratchet:list UNNAMED_ICON_BUTTONS
export const UNNAMED_ICON_BUTTONS: Baseline = {
};

// ratchet:list NOT_THROUGH_MODAL
export const NOT_THROUGH_MODAL: Baseline = {
};

// ratchet:list SMALL_ICON_BUTTONS
export const SMALL_ICON_BUTTONS: Baseline = {
};

// ratchet:list HOVER_ONLY_REVEALS
export const HOVER_ONLY_REVEALS: Baseline = {
};

// ── contrast (contrast.test.ts) ─────────────────────────────────────────────

// ratchet:list CONTRAST_BASELINE
export const CONTRAST_BASELINE: Baseline = {
};

// ratchet:list HARDCODED_COLOUR_BASELINE
export const HARDCODED_COLOUR_BASELINE: Baseline = {
};

// ── axe on rendered surfaces (axeSurfaces.test.tsx) ─────────────────────────

// ratchet:list AXE_BASELINE
export const AXE_BASELINE: Baseline = {
};
