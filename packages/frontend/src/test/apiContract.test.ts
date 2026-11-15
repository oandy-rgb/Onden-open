// @vitest-environment node
// API contract, frontend side. The backend records the SHAPE of every response
// it sends (packages/backend/src/test/apiContract.integration.test.ts →
// packages/markdown/contract/api-shapes.json). This test reads the types the
// app declares for those responses straight from the TypeScript source (the
// compiler API, no hand-kept field list) and checks that each recorded shape
// satisfies them:
//   - a field the type requires must be sent, in every response;
//   - every kind of value the backend sends for a field (string, number,
//     boolean, null, object, array) must be one the type accepts.
// A field the type marks optional may be absent, but when it is sent it must fit.
//
// A new required field on one of these types is checked with no change here.
// What to add when the app starts reading a new response is EXPECTATIONS below.
//
// Format of the file: packages/markdown/contract/README.md.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");
// Types both sides share are declared once in packages/contract and read from there.
const CONTRACT = "../../contract/src/index.ts";
const CONTRACT_FILE = resolve(here, "../../../markdown/contract/api-shapes.json");

// ── what the app reads ───────────────────────────────────────────────────

type Expectation = {
  /** The recorded route key, as in api-shapes.json. */
  route: string;
  /** The exported type the app reads this response as, and its file (under src/). */
  type: string;
  from: string;
  /** Where in the response the type applies: "" is the body, "spaces[]" each
   *  element of its `spaces` array. */
  at?: string;
  /** Fields of the type the app does not read from THIS route, with the reason
   *  (a path like "membership_epoch", relative to `at`). */
  ignore?: Record<string, string>;
};

const EXPECTATIONS: Expectation[] = [
  // The cold start: permissions (actor_is_owner, can_review, space ids), the
  // note list, tags, edges, tasks. Four forms; "lean2 decoded" is the compact
  // form after the app's own decoder (lib/data/bootstrapWire.ts).
  ...["full", "slim", "lean", "lean2 decoded"].map((variant): Expectation => ({
    route: `GET /api/bootstrap [${variant}]`, type: "Bootstrap", from: "lib/api.ts",
  })),
  // The delta the app pulls on every sync.
  { route: "POST /api/sync", type: "SyncDelta", from: "lib/localDb.ts" },
  { route: "GET /api/sync", type: "SyncDelta", from: "lib/localDb.ts" },
  // Spaces: who can write where. The incident of 2026-10-23 was this one.
  { route: "GET /api/spaces", type: "Space", from: "lib/spaces.ts", at: "spaces[]" },
  { route: "GET /api/spaces/:id/members", type: "SpaceMember", from: "lib/spaces.ts", at: "members[]" },
  { route: "GET /api/spaces/overview", type: "SpaceOverview", from: CONTRACT },
  { route: "GET /api/spaces/:id/delete-preview", type: "SpaceDeletePreview", from: CONTRACT },
  {
    route: "GET /api/spaces/move-preview", type: "MovePreview", from: CONTRACT,
  },
  // Notes: what an open note and a write's answer are read as.
  { route: "GET /api/nodes/:id", type: "ContentNode", from: "lib/api.ts" },
  { route: "POST /api/nodes", type: "ContentNode", from: "lib/api.ts" },
  { route: "PATCH /api/nodes/:id", type: "ContentNode", from: "lib/api.ts" },
  { route: "GET /api/nodes/:id/versions", type: "NoteVersion", from: "lib/data/reads.ts", at: "[]" },
  // History: the feed's days and their notes / AI runs / rewinds, the activity strip, the deleted list,
  // the workspace and one note as of an instant. (Bodies of the *undo* answers are not recorded.)
  // A day's page: the timeline's items and the notes of the day (under buckets).
  { route: "GET /api/day/:date/lens", type: "DayLens", from: "modules/daily/day/useDayLens.ts" },
  { route: "GET /api/history/activity", type: "ActivityDay", from: CONTRACT, at: "days[]" },
  { route: "GET /api/history/feed", type: "Feed", from: CONTRACT },
  { route: "GET /api/history/day/notes", type: "DayNotes", from: CONTRACT },
  { route: "GET /api/history/deleted", type: "DeletedNote", from: CONTRACT, at: "notes[]" },
  { route: "GET /api/history/at", type: "WorkspaceAt", from: CONTRACT },
  { route: "GET /api/history/at/:id", type: "NoteAt", from: CONTRACT },
  // Tags, canvases, tasks, inbox.
  { route: "GET /api/tags", type: "Tag", from: "lib/api.ts", at: "[]" },
  { route: "GET /api/canvases", type: "CanvasMeta", from: "lib/api.ts", at: "[]" },
  { route: "GET /api/canvases/:id", type: "Canvas", from: "lib/api.ts" },
  { route: "GET /api/tasks/agenda", type: "Agenda", from: "lib/data/taskAgenda.ts" },
  { route: "GET /api/inbox", type: "InboxEvent", from: "lib/api.ts", at: "events[]" },
  { route: "GET /api/inbox", type: "InboxFacets", from: "lib/api.ts", at: "facets" },
];

// ── the recorded shapes ──────────────────────────────────────────────────

type Raw = string | Raw[] | { [key: string]: Raw | boolean };
type Shape = {
  kinds: Set<string>;
  props: Map<string, { shape: Shape; optional: boolean }>;
  items: Shape | null;
  /** Free-form map: keys are data, only the value shape is known. */
  map: Shape | null;
};
type ContractFile = { routes: Record<string, { status: number; shape: Raw }>; unexercised: Record<string, string> };

const EMPTY = (): Shape => ({ kinds: new Set(), props: new Map(), items: null, map: null });

function parseShape(raw: Raw | boolean): Shape {
  const shape = EMPTY();
  if (typeof raw === "string") {
    for (const kind of raw.split("|")) if (kind && kind !== "unknown") shape.kinds.add(kind);
    if (raw === "unknown") shape.kinds.add("unknown");
    return shape;
  }
  if (Array.isArray(raw)) {
    shape.kinds.add("array");
    shape.items = parseShape(raw[0] ?? "unknown");
    return shape;
  }
  if (typeof raw === "boolean") return shape;
  const body = raw as Record<string, Raw | boolean>;
  const declared = typeof body.$kinds === "string" ? body.$kinds.split("|") : ["object"];
  for (const kind of declared) shape.kinds.add(kind);
  if (body.$items !== undefined) shape.items = parseShape(body.$items);
  if (body.$map !== undefined) shape.map = parseShape(body.$map);
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("$")) continue;
    const optional = key.endsWith("?");
    shape.props.set(optional ? key.slice(0, -1) : key, { shape: parseShape(value), optional });
  }
  return shape;
}

/** The part of a response `at` names ("" the body, "spaces[]" an array's elements). */
function shapeAt(root: Shape, at: string): Shape | null {
  let node: Shape | null = root;
  for (const step of at.match(/[^.[\]]+|\[\]/g) ?? []) {
    if (!node) return null;
    node = step === "[]" ? node.items : (node.props.get(step)?.shape ?? null);
  }
  return node;
}

// ── the types, read from the source ──────────────────────────────────────

let program: ts.Program | null = null;
function getProgram(): ts.Program {
  program ??= ts.createProgram({
    rootNames: [...new Set(EXPECTATIONS.map((e) => resolve(SRC, e.from)))],
    options: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, noEmit: true, resolveJsonModule: true,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    },
  });
  return program;
}

function exportedType(checker: ts.TypeChecker, from: string, name: string): ts.Type {
  const file = getProgram().getSourceFile(resolve(SRC, from));
  const moduleSymbol = file && checker.getSymbolAtLocation(file);
  const symbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name);
  if (!symbol) throw new Error(`apiContract: ${from} has no exported type ${name} — update EXPECTATIONS`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}

const F = ts.TypeFlags;
type Accepts = { any: boolean; kinds: Set<string>; objects: ts.Type[]; element: ts.Type | null };

/** What values a type accepts: kinds of JSON value, the object types to look
 *  into, the element type of an array. `undefined` is dropped (it means an
 *  absent key, which the caller judges). */
function accepts(checker: ts.TypeChecker, type: ts.Type, where: string): Accepts {
  const out: Accepts = { any: false, kinds: new Set(), objects: [], element: null };
  const visit = (t: ts.Type): void => {
    if (t.flags & F.Any) {
      if ((t as { intrinsicName?: string }).intrinsicName === "error") throw new Error(`apiContract: ${where} has a member whose type does not resolve; the checker would accept anything`);
      out.any = true;
    } else if (t.flags & (F.Unknown | F.TypeParameter)) out.any = true;
    else if (t.flags & F.Union) (t as ts.UnionType).types.forEach(visit);
    else if (t.flags & (F.String | F.StringLiteral | F.TemplateLiteral | F.StringMapping)) out.kinds.add("string");
    else if (t.flags & (F.Number | F.NumberLiteral | F.BigInt | F.BigIntLiteral)) out.kinds.add("number");
    else if (t.flags & F.EnumLiteral) out.kinds.add(t.flags & F.NumberLiteral ? "number" : "string");
    else if (t.flags & F.BooleanLike) out.kinds.add("boolean");
    else if (t.flags & F.Null) out.kinds.add("null");
    else if (t.flags & (F.Undefined | F.Void | F.Never)) { /* absent */ }
    else if (t.flags & F.NonPrimitive) { out.kinds.add("object"); out.any = true; }
    else if (t.flags & (F.Object | F.Intersection)) {
      if (checker.isArrayType(t) || checker.isTupleType(t)) {
        out.kinds.add("array");
        out.element ??= checker.getTypeArguments(t as ts.TypeReference)[0] ?? null;
      } else {
        out.kinds.add("object");
        out.objects.push(t);
      }
    } else out.any = true;
  };
  visit(type);
  return out;
}

const show = (kinds: Iterable<string>) => [...kinds].sort().join("|");

/** Problems of `shape` against `type`, one readable line each. */
function check(checker: ts.TypeChecker, type: ts.Type, shape: Shape, path: string, typeName: string, ignore: Record<string, string>, out: string[]): void {
  if (ignore[path] !== undefined) return;
  const what = accepts(checker, type, `${typeName}.${path}`);
  if (what.any) return;
  for (const kind of shape.kinds) {
    if (kind === "unknown" || what.kinds.has(kind)) continue;
    out.push(`${path || "(body)"}: the backend sends ${kind}, ${typeName} accepts ${show(what.kinds) || "nothing"}`);
  }
  if (shape.items && what.element) check(checker, what.element, shape.items, `${path}[]`, typeName, ignore, out);
  // Only a plain object type has properties to hold the backend to; a union of
  // several object types or a Record is checked by kind alone.
  if (what.objects.length !== 1 || !shape.kinds.has("object")) return;
  const object = what.objects[0]!;
  if (checker.getIndexInfosOfType(object).length > 0 && checker.getPropertiesOfType(object).length === 0) {
    const info = checker.getIndexInfosOfType(object)[0]!;
    if (shape.map) check(checker, info.type, shape.map, `${path}{}`, typeName, ignore, out);
    else for (const [key, prop] of shape.props) check(checker, info.type, prop.shape, `${path ? `${path}.` : ""}${key}`, typeName, ignore, out);
    return;
  }
  for (const property of checker.getPropertiesOfType(object)) {
    const key = property.name;
    const child = path ? `${path}.${key}` : key;
    if (ignore[child] !== undefined) continue;
    const required = !(property.flags & ts.SymbolFlags.Optional);
    const sent = shape.props.get(key);
    const propertyType = checker.getTypeOfSymbol(property);
    if (!sent) {
      if (required && !shape.map) out.push(`${child}: ${typeName} requires it, the backend never sends it`);
      continue;
    }
    if (required && sent.optional) out.push(`${child}: ${typeName} requires it, the backend leaves it out of some responses`);
    check(checker, propertyType, sent.shape, child, typeName, ignore, out);
  }
}

export function problemsFor(contract: ContractFile, expectation: Expectation): string[] {
  const recorded = contract.routes[expectation.route];
  if (!recorded) return [`${expectation.route}: not in api-shapes.json (the backend test no longer records it)`];
  const root = parseShape(recorded.shape);
  const at = expectation.at ?? "";
  const shape = shapeAt(root, at);
  if (!shape) return [`${expectation.route}: nothing at "${at}" in the recorded response`];
  const checker = getProgram().getTypeChecker();
  const out: string[] = [];
  check(checker, exportedType(checker, expectation.from, expectation.type), shape, "", expectation.type, expectation.ignore ?? {}, out);
  return out.map((line) => `${expectation.route}${at ? ` (${at})` : ""} → ${line}`);
}

const contract = JSON.parse(readFileSync(CONTRACT_FILE, "utf-8")) as ContractFile;

describe("API contract: what the backend sends vs what the app's types read", () => {
  for (const expectation of EXPECTATIONS) {
    it(`${expectation.route}${expectation.at ? ` ${expectation.at}` : ""} fits ${expectation.type}`, () => {
      const problems = problemsFor(contract, expectation);
      expect(problems, `The backend and the frontend disagree. Either the server changed (regenerate packages/markdown/contract/api-shapes.json only if that was intended, and fix the reader) or the type asks for something the server never sent.\n\n${problems.join("\n")}\n`).toEqual([]);
    }, 120_000);
  }

  it("sees the 2026-10-23 incident: a space whose permission field was renamed", () => {
    const renamed = structuredClone(contract) as ContractFile;
    const spaces = (renamed.routes["GET /api/spaces"]!.shape as { spaces: Array<Record<string, Raw | boolean>> }).spaces[0]!;
    spaces.role = spaces.permission!;
    delete spaces.permission;
    const problems = problemsFor(renamed, EXPECTATIONS.find((e) => e.route === "GET /api/spaces")!);
    expect(problems.join("\n")).toContain("GET /api/spaces (spaces[]) → permission: Space requires it, the backend never sends it");
  }, 120_000);

  it("sees a field that starts to be null", () => {
    const nullable = structuredClone(contract) as ContractFile;
    const spaces = (nullable.routes["GET /api/spaces"]!.shape as { spaces: Array<Record<string, Raw | boolean>> }).spaces[0]!;
    spaces.name = "null|string";
    const problems = problemsFor(nullable, EXPECTATIONS.find((e) => e.route === "GET /api/spaces")!);
    expect(problems.join("\n")).toContain("name: the backend sends null, Space accepts string");
  }, 120_000);

  it("every expectation names a route the backend records", () => {
    for (const expectation of EXPECTATIONS) {
      expect(Object.keys(contract.routes), expectation.route).toContain(expectation.route);
    }
  });
});
