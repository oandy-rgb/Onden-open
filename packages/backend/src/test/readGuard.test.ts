// Read guard — the by-construction backstop for read authorization.
//
// The companion to spineGate.test.ts. Where that gate forces every WRITE
// through mutate(), this one forces every file that READS content_nodes
// (FROM/JOIN) and serves it to make a conscious read-authorization choice. The
// Critical leak this guards against (audit #1/#2): a read that SELECTs from
// content_nodes and serves it without consulting the read-policy lets any
// authenticated actor — a low-role human, or a tag-scoped agent — read nodes
// they shouldn't.
//
// This vitest gate and the eslint rule onden/require-read-gate share ONE source
// of truth: the GATED/INTERNAL/DEFERRED maps live in the rule and are imported
// here, so they cannot drift. The 2026-06-27 flip widened coverage from
// routes/*.ts GET handlers to the WHOLE backend src tree — every reader must be
// in exactly one bucket or the build fails:
//
//   GATED    — serves node data; must reference a read-policy primitive
//              (asserted, so a file can't be listed then quietly drop it).
//   INTERNAL — write-path / lookup / policy-internal; not served. Has a reason.
//   DEFERRED — public/published surface; opt-in filtered, not actor-scoped.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { READ_GATE } from "../../eslint-rules/require-read-gate.js";

const { GATED, INTERNAL, DEFERRED, TYPED_GATED, readsNodes, EVENT_READS, readsEvents, usesGate } = READ_GATE;

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every non-test .ts under src/, as a path relative to src/ with POSIX
// separators (the maps key on e.g. "services/agentTools/getNode.ts").
function allSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "test") continue;
      out.push(...allSrcFiles(full));
    } else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("read guard — files that read content_nodes are classified", () => {
  const readers = allSrcFiles(srcDir)
    .map((full) => ({ rel: relative(srcDir, full).split(sep).join("/"), src: readFileSync(full, "utf8") }))
    .filter(({ src }) => readsNodes(src));

  for (const { rel, src } of readers) {
    it(`${rel}: is classified (gated / internal / deferred)`, () => {
      const buckets = (GATED[rel] ? 1 : 0) + (INTERNAL[rel] ? 1 : 0) + (DEFERRED[rel] ? 1 : 0);
      expect(
        buckets,
        `${rel} reads content_nodes (FROM/JOIN) but is in no bucket — GATE it (canReadNode / ` +
          `readableScopeSql / readableNodeIdSet) or add an INTERNAL/DEFERRED reason in ` +
          `eslint-rules/require-read-gate.js`,
      ).toBe(1);
      // A GATED file must actually reference its claimed primitive.
      if (GATED[rel]) {
        expect(usesGate(src, GATED[rel]), `${rel} is GATED but doesn't use ${GATED[rel]} (an import or a comment is not enough)`).toBe(true);
      }
    });
  }

  it("classifies a non-trivial number of readers (catches a broken walk/glob)", () => {
    expect(readers.length).toBeGreaterThan(20);
  });

  it("every GATED/INTERNAL/DEFERRED entry still corresponds to a real reader file", () => {
    const live = new Set(readers.map((r) => r.rel));
    for (const f of [...Object.keys(GATED), ...Object.keys(INTERNAL), ...Object.keys(DEFERRED)]) {
      expect(live.has(f), `${f} is listed but no longer reads content_nodes (FROM/JOIN) — drop it`).toBe(true);
    }
  });
});

describe("read guard — files that read domain_events are classified", () => {
  const readers = allSrcFiles(srcDir)
    .map((full) => ({ rel: relative(srcDir, full).split(sep).join("/"), src: readFileSync(full, "utf8") }))
    .filter(({ src }) => readsEvents(src));

  for (const { rel, src } of readers) {
    it(`${rel}: event read is classified`, () => {
      const rule: RegExp | string | undefined = EVENT_READS[rel];
      expect(rule, `${rel} reads domain_events but is not in EVENT_READS (eslint-rules/require-read-gate.js)`).toBeDefined();
      if (rule instanceof RegExp) expect(usesGate(src, rule), `${rel} is listed but doesn't use ${rule} (an import or a comment is not enough)`).toBe(true);
    });
  }

  it("every EVENT_READS entry still reads domain_events", () => {
    const live = new Set(readers.map((r) => r.rel));
    for (const f of Object.keys(EVENT_READS)) {
      expect(live.has(f), `${f} is listed but no longer reads domain_events — drop it`).toBe(true);
    }
  });

  it("the typed-builder readers (TYPED_GATED) exist and still reference their read-policy primitive", () => {
    for (const [rel, primitive] of Object.entries(TYPED_GATED)) {
      const src = readFileSync(join(srcDir, rel), "utf8");
      expect(usesGate(src, primitive), `${rel} is in TYPED_GATED but doesn't use ${primitive}`).toBe(true);
    }
  });
});
