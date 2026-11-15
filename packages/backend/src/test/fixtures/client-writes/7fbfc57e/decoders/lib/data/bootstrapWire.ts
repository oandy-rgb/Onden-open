// @ts-nocheck
// Snapshot of src/lib/data/bootstrapWire.ts as released (npm run capture:client-writes); not type-checked here.
// Decoder for the compact bootstrap (`X-Onden-Bootstrap: lean2`), the one
// place that knows the format. Its definition and the list of what is left
// out is backend services/sync/bootstrapWire.ts. decodeBootstrapWire returns
// the lean shape the app already handles — full node objects with workspace
// id, nulls, defaults and tag/actor lists restored, and flat `attributes`
// rows — so syncEngine.fetchBootstrap carries on with attrs_omitted as before.

import type { Bootstrap } from "../api";

/** Sent by fetchBootstrap. An older server does not know it and answers in
 *  the lean-less shape, which decodeBootstrapWire passes through. */
export const BOOTSTRAP_HEADER_VALUE = "lean2";

const NODE_NULLABLE = [
  "parent_id", "presentation", "deleted_at", "deleted_by_event_id", "tag_color", "tag_schema",
  "collection_views", "reserved_key", "tag_is_inheritable", "space_id", "last_actor", "last_modified_at",
] as const;

type WireBootstrap = Omit<Bootstrap, "nodes" | "attributes"> & {
  wire?: number;
  dict?: string[];
  nodes: Array<Record<string, unknown>>;
  attributes?: Array<Record<string, unknown>>;
  attribute_groups?: Array<[number, Array<[number, string, number | null, 0 | 1 | null, number | null]>]>;
};

/** `data` as the server sent it → the bootstrap the app uses. A payload that
 *  is not compact (no `wire`) is returned as it is. */
export function decodeBootstrapWire(data: Bootstrap): Bootstrap {
  const wire = data as unknown as WireBootstrap;
  if (wire.wire === undefined) return data;
  if (wire.wire !== 2 || !Array.isArray(wire.dict)) throw new Error(`Unsupported bootstrap format ${String(wire.wire)}`);
  const dict = wire.dict;
  const str = (i: number): string => dict[i]!;
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as number[]).map(str) : []);
  const workspaceId = data.workspace.id;

  const nodes = wire.nodes.map((n) => {
    const node: Record<string, unknown> = {
      workspace_id: workspaceId, source_type: "manual", node_type: "content", hidden: false, sort_order: 0,
      ...n,
    };
    for (const key of NODE_NULLABLE) if (node[key] === undefined) node[key] = null;
    for (const key of ["space_id", "last_actor"] as const) if (typeof node[key] === "number") node[key] = str(node[key]);
    for (const key of ["class_tag_ids", "label_tag_ids", "recent_actors"] as const) node[key] = list(node[key]);
    return node;
  });

  const attributes: Array<Record<string, unknown>> = [];
  for (const [at, rows] of wire.attribute_groups ?? []) {
    const node_id = nodes[at]!.id;
    for (const [key, value, type, inheritable, source] of rows) {
      attributes.push({
        node_id, key: str(key), value,
        value_type: type === null ? null : str(type),
        is_inheritable: inheritable === null ? null : inheritable === 1,
        source: source === null ? null : str(source),
      });
    }
  }
  attributes.push(...(wire.attributes ?? []));

  const { wire: _wire, dict: _dict, attribute_groups: _groups, ...rest } = wire;
  return { ...rest, nodes, attributes } as unknown as Bootstrap;
}
