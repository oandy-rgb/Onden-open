// Defense-in-depth guard: permission / governance data must be gated by the
// workspace-owner check (it denies bearer tokens AND anyone but the owner),
// NOT a bare role-rank admin check. Since D9 that check is services/actors.ts's
// principal(), and every operation there must run it FIRST — before any lookup
// or body read — so a non-principal can't probe ids via 404-vs-403 either.
//
// The bug this pins: GET /:id/tokens and GET /:id/stats gated on
// `(ROLE_RANK[...] ?? -1) < ROLE_RANK.admin`, which a DELEGATED admin-role
// BEARER token passes — its tokenScope made no difference. Only the global
// /api/mcp confinement middleware happened to stop a token from reaching these
// routes. Token metadata IS an escalation-target list and a governance meter
// is sensitive; they must gate like permission administration.
// Source-grep (no eslint for this) so a future edit can't silently revert.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ...parts), "utf8");
const service = read("services", "actors.ts");
const route = read("routes", "actors.ts");

/** Each `export async function` with the first statement of its body
 *  (comments skipped). The signature may span lines and its return type may
 *  hold braces (Promise<{ ok: true }>), so the body's `{` is the first one at
 *  depth 0 after the parameter list. */
function exportedFirstStatements(src: string): Array<{ name: string; first: string }> {
  const out: Array<{ name: string; first: string }> = [];
  for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
    let i = m.index! + m[0].length;
    for (let depth = 1; depth > 0; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
    let angle = 0, brace = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "<") angle++;
      else if (ch === ">" && src[i - 1] !== "=") angle--;
      else if (ch === "{" && angle === 0 && brace === 0) break;
      else if (ch === "{") brace++;
      else if (ch === "}") brace--;
    }
    const body = src.slice(i + 1).replace(/^(\s*\/\/[^\n]*\n)*\s*/, "");
    out.push({ name: m[1]!, first: body.slice(0, body.indexOf(";") + 1) });
  }
  return out;
}

describe("permission administration gates on the workspace owner first", () => {
  it("no bare `< ROLE_RANK.admin` gate in the service or the route", () => {
    // The exact removed idiom: `if ((ROLE_RANK[...] ?? -1) < ROLE_RANK.admin) return ...`.
    // (The one legit role-rank use is the self-escalation guard,
    //  `>= ROLE_RANKS.admin && actor.id === id` — a different shape, not a gate.)
    for (const src of [service, route]) expect(src).not.toMatch(/<\s*ROLE_RANKS?\.admin\s*\)\s*(return|throw)/);
  });

  it("every exported operation's first statement is the principal() gate", () => {
    // actorForSession (D110) is not administration: it resolves the signed-in
    // login's OWN member (lookup, invite claim, first sign-in), never another's.
    const ops = exportedFirstStatements(service).filter((o) => o.name !== "actorForSession");
    // The eleven operations, including the two the bug pinned (listTokens, actorStats).
    expect(ops.map((o) => o.name).sort()).toEqual([
      "actorStats", "changeTokenAccess", "createActor", "deleteToken", "listActors", "listTokens",
      "mintToken", "regenerateInvite", "removeActor", "revokeTokenOf", "updateActor",
    ]);
    for (const { name, first } of ops) {
      expect(first, `${name} must start with principal(authenticated…)`).toMatch(/^(const actor = )?await principal\(authenticated[,)]/);
    }
  });

  it("principal() is the owner check (no token, workspace owner)", () => {
    const fn = service.slice(service.indexOf("async function principal("), service.indexOf("async function requireMember("));
    expect(fn).toContain("requireActor(authenticated)");
    expect(fn).toContain("isWorkspaceOwner(actor)");
    expect(fn).toContain('error: "owner_only"');
  });

  it("the route calls nothing but the service (no lookups of its own)", () => {
    const code = route.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\b(pool|q)\b\s*[.(]/);
    expect(code).not.toMatch(/\bmutate\(/);
  });
});
