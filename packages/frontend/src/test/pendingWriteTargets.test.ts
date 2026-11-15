// What a queued write acts on (D45): one reading of every endpoint shape the
// offline queue carries, recorded targets preferred over decoding, and the
// stored form round-tripping (rows from before targets were recorded decode).
import { describe, it, expect } from "vitest";
import { writeTargets, targetIds, targetsEntity, parseStoredTargets, type WriteTarget } from "../lib/pendingWriteTargets";

const N = "00000000-0000-4000-8000-000000000001";
const M = "00000000-0000-4000-8000-000000000002";
const body = (value: unknown) => JSON.stringify(value);

describe("writeTargets: each endpoint shape", () => {
  it.each<[string, string, string, string | null, WriteTarget[]]>([
    ["note create", "POST", "/api/nodes", body({ id: N, title: "t", markdown: `[[${M}]]` }), [{ kind: "node", id: N }]],
    ["note change", "PATCH", `/api/nodes/${N}`, body({ markdown: `onden://node/${M}` }), [{ kind: "node", id: N }]],
    ["note trash", "DELETE", `/api/nodes/${N}`, null, [{ kind: "node", id: N }]],
    ["note promote", "POST", `/api/nodes/${N}/promote`, null, [{ kind: "node", id: N, part: "promote" }]],
    ["note undelete", "POST", `/api/nodes/${N}/undelete`, null, [{ kind: "node", id: N, part: "undelete" }]],
    ["note duplicate", "POST", `/api/nodes/${N}/duplicate`, body({ id: M }),
      [{ kind: "node", id: N, part: "duplicate" }, { kind: "node", id: M }]],
    ["attribute", "PUT", `/api/nodes/${N}/attributes/${encodeURIComponent("due date")}`, body({ value: "x" }),
      [{ kind: "node", id: N, part: "attributes/due date" }]],
    ["ink", "PUT", `/api/nodes/${N}/attributes/ink_data`, body({ value: "{}" }), [{ kind: "node", id: N, part: "attributes/ink_data" }]],
    ["tag apply", "PUT", `/api/nodes/${N}/tags/${M}`, "{}", [{ kind: "node", id: N, part: `tags/${M}` }]],
    ["graph position", "PUT", `/api/nodes/${N}/position`, body({ x: 1 }), [{ kind: "node", id: N, part: "position" }]],
    ["task create", "POST", `/api/nodes/${N}/tasks`, body({ id: "t1", title: "x" }),
      [{ kind: "node", id: N, part: "tasks" }, { kind: "task", id: "t1" }]],
    ["task change", "PATCH", "/api/tasks/t1", body({ status: "done" }), [{ kind: "task", id: "t1" }]],
    ["edge create", "POST", "/api/edges", body({ id: "e1", source_node_id: N, target_node_id: M }), [{ kind: "edge", id: "e1" }]],
    ["edge delete", "DELETE", "/api/edges/e1", null, [{ kind: "edge", id: "e1" }]],
    ["canvas create", "POST", "/api/canvases", body({ id: "c1", title: "b" }), [{ kind: "canvas", id: "c1" }]],
    ["canvas change", "PATCH", "/api/canvases/c1", body({ title: "b" }), [{ kind: "canvas", id: "c1" }]],
    ["tag board", "PATCH", `/api/boards/${N}`, body({ cards: [] }), [{ kind: "board", id: N }]],
    ["tag create", "POST", "/api/tags", body({ id: N, name: "x" }), [{ kind: "tag", id: N }]],
    ["tag schema", "PATCH", `/api/tags/${N}/schema`, body({}), [{ kind: "tag", id: N, part: "schema" }]],
    ["pointer delete", "DELETE", "/api/pointers/p1", null, [{ kind: "pointer", id: "p1" }]],
    ["feed item save", "POST", "/api/rss/items/a1/save", body({ node_id: N }), [{ kind: "node", id: N }]],
    ["feed subscribe", "POST", "/api/rss/subscribe", body({ url: "https://x" }), []],
    ["query and hash", "PATCH", `/api/nodes/${N}?x=1#y`, body({}), [{ kind: "node", id: N }]],
    ["create, bad body", "POST", "/api/nodes", "{not json", []],
    ["create, no id", "POST", "/api/nodes", body({ title: "t" }), []],
    ["bad escape", "PATCH", "/api/nodes/%E0%A4%A", body({}), []],
    ["not the api", "PATCH", `/nodes/${N}`, body({}), []],
    ["prototype key", "PATCH", "/api/constructor/x", null, []],
  ])("%s", (_name, method, path, requestBody, expected) => {
    expect(writeTargets({ method, path, body: requestBody })).toEqual(expected);
  });
});

describe("reading targets", () => {
  it("prefers the targets recorded at enqueue over the request", () => {
    const recorded: WriteTarget[] = [{ kind: "node", id: M }];
    expect(writeTargets({ method: "PATCH", path: `/api/nodes/${N}`, body: null, targets: recorded })).toBe(recorded);
  });

  it("an id mentioned in a body is not a target", () => {
    const edge = { method: "POST", path: "/api/edges", body: body({ id: "e1", source_node_id: N, target_node_id: M }) };
    const link = { method: "PATCH", path: `/api/nodes/${N}`, body: body({ markdown: `see onden://node/${M}` }) };
    expect(targetIds(edge, "node")).toEqual([]);
    expect(targetIds(link, "node")).toEqual([N]);
  });

  it("tells the entity itself from one of its parts", () => {
    const attribute = { method: "DELETE", path: `/api/nodes/${N}/attributes/k`, body: null };
    expect(targetIds(attribute, "node")).toEqual([N]);
    expect(targetsEntity(attribute, "node", N)).toBe(false);
    expect(targetsEntity({ method: "DELETE", path: `/api/nodes/${N}`, body: null }, "node", N)).toBe(true);
  });

  it("stored targets round-trip; anything unreadable decodes from the request", () => {
    const targets: WriteTarget[] = [{ kind: "node", id: N, part: "tasks" }, { kind: "task", id: "t1" }];
    expect(parseStoredTargets(JSON.stringify(targets))).toEqual(targets);
    expect(parseStoredTargets(JSON.stringify([]))).toEqual([]);
    for (const raw of [null, undefined, "", "{", "{}", JSON.stringify([{ kind: "file", id: "x" }]), JSON.stringify([{ kind: "node" }])]) {
      expect(parseStoredTargets(raw)).toBeUndefined();
    }
  });
});
