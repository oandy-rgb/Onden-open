// Guard: a ticket is made only after its evidence was checked (services/freshProof.ts issueFreshProof), and the snapshot export spends one.
// No other production file touches the ticket table: a route that wrote its own row would hand tickets to anyone who asks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { code, productionFiles, rel, SRC } from "./nodeStoreOwnershipScan.js";

describe("fresh-proof tickets", () => {
  it("only freshProof.ts reads or writes the tickets, and it makes one only after it checked the evidence", () => {
    const users = productionFiles().map(rel).filter((f) => /\bfresh_proofs\b/.test(code(readFileSync(join(SRC, f), "utf8"))) && !/^(db\.ts|dbSchema\.generated\.ts)$/.test(f)).sort();
    expect(users, "a new reader or writer of the ticket table: tickets are made by issueFreshProof (after the evidence) and spent by consumeFreshProof").toEqual(["services/freshProof.ts"]);
    const text = code(readFileSync(join(SRC, "services/freshProof.ts"), "utf8"));
    // inside issueFreshProof the check comes before the grant
    const issue = text.slice(text.indexOf("export async function issueFreshProof"), text.indexOf("async function grantFreshProof"));
    expect(issue.indexOf("checkEvidence(")).toBeGreaterThan(-1);
    expect(issue.indexOf("checkEvidence(")).toBeLessThan(issue.indexOf("grantFreshProof("));
  });

  it("the snapshot export spends a ticket before it reads anything", () => {
    const text = code(readFileSync(join(SRC, "services/stampedSnapshotStream.ts"), "utf8"));
    const exportFn = text.slice(text.indexOf("export async function exportSnapshotStream"));
    expect(exportFn.indexOf('consumeFreshProof(actor, "snapshot_export"')).toBeGreaterThan(-1);
    expect(exportFn.indexOf("consumeFreshProof(")).toBeLessThan(exportFn.indexOf("readStampedPages("));
  });

  it("the actor middleware puts the sign-in session on the request, so a ticket really is bound to one (else both sides see none and the binding does nothing)", () => {
    const app = code(readFileSync(join(SRC, "app.ts"), "utf8"));
    expect(app).toMatch(/withRequestSession\(signedIn\.sessionId/);
    expect(code(readFileSync(join(SRC, "services/freshProof.ts"), "utf8"))).toMatch(/currentSessionId\(\)/);
  });
});
