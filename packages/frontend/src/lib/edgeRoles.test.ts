import { describe, it, expect } from "vitest";
import {
  canDelete, canRetype, countsAsBacklink, drawsInGraph, drawsOnBoard, edgeRole, existingRelation, publishes,
  type EdgeFacts,
} from "./edgeRoles";

// One row per kind of edge the server stores (D74).
const ROWS: Record<string, EdgeFacts> = {
  wikilink: { edge_type: "knowledge_link", status: "active", origin: "wikilink" },
  drawnLink: { edge_type: "knowledge_link", status: "active", origin: "manual" },
  drawnSupports: { edge_type: "supports", status: "active", origin: "manual" },
  citation: { edge_type: "cites", status: "active", origin: "citation" },
  suggestion: { edge_type: "suggested_link", status: "suggested", origin: "semantic" },
  rejected: { edge_type: "suggested_link", status: "rejected", origin: "semantic" },
  nav: { edge_type: "nav_link", status: "active", origin: "manual" },
  // A local row stored before the mirror had an origin column.
  legacy: { edge_type: "knowledge_link", status: "active", origin: null },
};
const pick = (predicate: (e: EdgeFacts) => boolean) => Object.keys(ROWS).filter((k) => predicate(ROWS[k]!));

describe("edgeRole", () => {
  it("reads derived, manual and suggestion from origin and status", () => {
    expect(Object.fromEntries(Object.entries(ROWS).map(([k, e]) => [k, edgeRole(e)]))).toEqual({
      wikilink: "derived", drawnLink: "manual", drawnSupports: "manual", citation: "derived",
      suggestion: "suggestion", rejected: "suggestion", nav: "manual", legacy: "manual",
    });
  });
});

describe("the view predicates", () => {
  it("a board draws relations and the suggestions still waiting, never site navigation or a rejected one", () => {
    expect(pick(drawsOnBoard)).toEqual(["wikilink", "drawnLink", "drawnSupports", "citation", "suggestion", "legacy"]);
  });

  it("graphs, the Links lens and the export draw relations only", () => {
    expect(pick(drawsInGraph)).toEqual(["wikilink", "drawnLink", "drawnSupports", "citation", "legacy"]);
  });

  it("a backlink is an active plain link, from the text or drawn by hand; no suggestion or typed relation", () => {
    expect(pick(countsAsBacklink)).toEqual(["wikilink", "drawnLink", "legacy"]);
  });

  it("the published site keeps active links of a published type only", () => {
    expect(pick(publishes)).toEqual(["wikilink", "drawnLink", "nav", "legacy"]);
    expect(publishes({ edge_type: "suggested_link", status: "active" })).toBe(true);
  });

  it("only a derived edge is out of reach of delete and retype", () => {
    expect(pick((e) => !canDelete(e))).toEqual(["wikilink", "citation"]);
    expect(pick((e) => !canRetype(e))).toEqual(["wikilink", "citation"]);
  });
});

describe("existingRelation", () => {
  const edges = [
    { id: "w", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active", origin: "wikilink" },
    { id: "s", source_node_id: "a", target_node_id: "c", edge_type: "suggested_link", status: "suggested", origin: "semantic" },
    { id: "r", source_node_id: "a", target_node_id: "d", edge_type: "knowledge_link", status: "rejected", origin: "manual" },
  ];
  it("finds the active edge of that type and direction, any origin", () => {
    expect(existingRelation(edges, "a", "b", "knowledge_link")?.id).toBe("w");
    expect(existingRelation(edges, "b", "a", "knowledge_link")).toBeUndefined();
    expect(existingRelation(edges, "a", "b", "supports")).toBeUndefined();
    expect(existingRelation(edges, "a", "d", "knowledge_link")).toBeUndefined();
  });
});
