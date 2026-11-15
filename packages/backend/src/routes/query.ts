// Query block — Dataview-inspired inline querying of the workspace.
//
// Accepts a small JSON spec (the frontend's onden-query code block parses
// a YAML-ish syntax into this shape) and returns matching nodes:
//
//   tags  — array of tag names (case-insensitive, as Bases' file.hasTag);
//           matches nodes carrying at least one
//   where — object whose values are EITHER a bare string (equality sugar,
//           the legacy shape) OR a { op, value } clause. Operators are the
//           shared filter compiler's set: eq/ne/contains/empty/nempty plus
//           the range ops gt/gte/lt/lte (so year>=2020 / overdue-before-today
//           are expressible). Always the same compiler as executeView — one
//           operator dialect, not a 2nd.
//   sort  — sort field; "-prefix" for descending. Built-in columns sort
//           directly; any other field sorts by that node_attribute value
//           (missing → last). Parameterised — never a SQL fragment.
//   limit — capped at 200 server-side regardless of request
//   offset — cursor pagination (skip N rows); the response echoes the
//           next offset when more rows may exist.
//
// Unknown keys are refused (400), never ignored: `{ tag: "x" }` used to be
// stripped and the query listed every note.
//
// All filters compose with AND. Hidden nodes, tag definitions and system
// machinery (reservedNodes.LISTED_NODE_SQL — class_tag rows, source_type
// 'system') are excluded. The query is
// strictly read-only — no parameter accepts SQL fragments.

import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { nodeQuerySchema, runNodeQuery } from "../services/nodeQuery.js";
import { parseBody } from "./params.js";

// The query itself lives in services/nodeQuery.ts (depth audit D13).
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.post("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  const body = await parseBody(c, nodeQuerySchema);
  return c.json(await runNodeQuery(c.get("actor"), workspaceId, body));
});

export default router;
