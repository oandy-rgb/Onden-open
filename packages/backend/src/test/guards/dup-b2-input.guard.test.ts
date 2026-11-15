// Request input has one reader each (docs/research/dup-patterns-2026-10-30-be.md, R5 / R15; R8, the body, is eslint onden/route-input).
// The rule is "only the owner file does X": any other file that does it fails here.
// `PENDING` lists the files that still do X because another branch is editing them;
// each entry must still violate (so the list only shrinks) and says why it waits.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Source without comments, so a rule that quotes the old spelling does not trip itself. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: code(readFileSync(path, "utf8")) }));
const isRouteFile = (file: string) => file.startsWith("routes/") || /^modules\/[^/]+\/routes\.ts$/.test(file);

type Rule = { id: string; pattern: RegExp; owners: string[]; scope: (file: string) => boolean; pending: Record<string, string> };

const WAITING = "being edited by an open branch (feat/ai-*, fix/settings-simplify, feat/patch-*, feat/day-*); move it to the owner when that lands";

const RULES: Rule[] = [
  {
    id: "R5: a uuid path/query id is checked by routes/params.ts uuidParam / uuidQuery",
    pattern: /\bisUuid\(|\buuid\(\)\s*\.\s*(?:safeParse|parse)\(\s*(?:c\.req\.(?:param|query)|id\b)|\bUUID\.parse\(c\.req\.|(?:z\.)?uuid\(\)\.safeParse\(\s*(?:raw|id)\b/,
    owners: ["routes/params.ts"],
    scope: isRouteFile,
    // ratchet:list R5-uuid-param-pending
    pending: {
      "routes/nodes.ts": WAITING,
      "routes/sync.ts": `${WAITING}; checks the ids inside a body list`,
      "routes/agentSessions.ts": WAITING,
    },
  },
  {
    id: "R5: no hand-written uuid regex (@onden/markdown isUuid is the check)",
    pattern: /\[0-9a-f\]\{8\}-/i,
    owners: [],
    scope: () => true,
    // ratchet:list R5-uuid-regex-pending
    pending: {},
  },
  {
    id: "R5: ids are compared as uuid (`id = ANY($n::uuid[])`), not `id::text = ANY($n::text[])`",
    pattern: /::text\s*=\s*ANY\(/,
    owners: [],
    scope: () => true,
    // ratchet:list R5-text-cast-pending
    pending: {
      "services/history/activity.ts": WAITING,
      "services/history/agentRuns.ts": WAITING,
      "services/wikilinkEdges.ts": "compares the text 'node:<id>' against link strings, not an id parameter",
    },
  },
  {
    id: "R15: a count/limit/days query is read by services/paging.ts parseCount (no parseInt / parseFloat / Number(query))",
    pattern: /\b(?:Number\.)?parseInt\(|\bparseFloat\(|\bNumber\(\s*c\.req\.query\(/,
    owners: [],
    scope: isRouteFile,
    // ratchet:list R15-pending
    pending: { "routes/sync.ts": `${WAITING}; the \`since\` cursor, which parseInt turns into 0 or a prefix ("12abc" → 12)` },
  },
];

function offenders(rule: Rule, universe = files): string[] {
  return universe.filter((f) => rule.scope(f.file) && !rule.owners.includes(f.file) && rule.pattern.test(f.text)).map((f) => f.file);
}

describe("one reader per kind of request input", () => {
  for (const rule of RULES) {
    it(rule.id, () => {
      const found = offenders(rule);
      expect(found.filter((f) => !(f in rule.pending)), `docs/research/dup-patterns-2026-10-30-be.md — use the owner`).toEqual([]);
      // The waiting list only shrinks: a file that no longer does it must leave the list.
      expect(Object.keys(rule.pending).filter((f) => !found.includes(f))).toEqual([]);
    });
  }

  it("every pending entry says why it waits", () => {
    for (const rule of RULES) for (const [file, why] of Object.entries(rule.pending)) expect(why.length, `${rule.id}: ${file}`).toBeGreaterThan(10);
  });

  it("the rules catch the spellings they replace", () => {
    const bad: Record<string, string> = {
      "R5: a uuid path": `const id = z.string().uuid().parse(c.req.param("id")); if (!isUuid(id)) return 404;`,
      "R5: no hand": `ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))`,
      "R5: ids are": `WHERE n.id::text = ANY($2::text[])`,
      "R15": `const n = parseInt(c.req.query("limit") ?? "0", 10);`,
    };
    for (const rule of RULES) {
      const sample = Object.entries(bad).find(([k]) => rule.id.startsWith(k))![1];
      const fake = [{ file: "routes/fake.ts", text: code(sample) }];
      expect(offenders(rule, fake), rule.id).toEqual(["routes/fake.ts"]);
    }
    // ...and the owner's own spelling is not flagged.
    const ok = [{ file: "routes/fake.ts", text: code(`const body = await parseBody(c, schema); const id = uuidParam(c, "id"); WHERE n.id = ANY($2::uuid[]) // was id::text = ANY(...)`) }];
    for (const rule of RULES) expect(offenders(rule, ok), rule.id).toEqual([]);
  });
});
