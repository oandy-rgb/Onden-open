// Compact bootstrap wire format, version 2 (perf F2-1). A client that sends
// `X-Onden-Bootstrap: lean2` gets the lean bootstrap (no attrs maps, no
// drawings) with its nodes and attributes encoded as below; `lean` (older
// clients, including shells cached by the service worker) keeps the format
// they understand, so this file only ever runs for lean2. The decoder is
// frontend lib/data/bootstrapWire.ts and returns the lean shape unchanged, so
// nothing past the fetch boundary knows this format exists.
//
// What is left out, none of it information:
//   • nodes[].workspace_id (the workspace row carries it once);
//   • null fields, `false` hidden, an empty order_stamp, source_type "manual",
//     node_type "content" and empty tag / actor lists — the decoder puts the
//     same defaults back (WIRE_NODE_NULLABLE below is the list it restores);
//   • repeated strings: space ids, tag ids, actor ids, attribute keys, types
//     and sources are stored once in `dict` and referenced by index;
//   • one `attributes` row per attribute: `attribute_groups` is
//     [[node index, [[key, value, value_type, is_inheritable (1/0/null),
//     source], …]], …] with the node as its position in `nodes` and key,
//     value_type and source as `dict` indexes.
// Rows whose node is not in `nodes` stay plain in `attributes`.

export const BOOTSTRAP_WIRE_VERSION = 2;

/** Node columns the decoder restores as null when absent. */
export const WIRE_NODE_NULLABLE = [
  "parent_id", "presentation", "deleted_at", "deleted_by_event_id", "tag_color", "tag_schema",
  "collection_views", "reserved_key", "space_id", "last_actor", "last_modified_at",
] as const;

/** Node columns holding one dictionary-indexed string / a list of them. */
const DICT_SCALARS = ["space_id", "last_actor"] as const;
const DICT_LISTS = ["class_tag_ids", "label_tag_ids", "recent_actors"] as const;

type Row = Record<string, unknown>;

class Dict {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();
  ref(value: string): number {
    let i = this.index.get(value);
    if (i === undefined) { i = this.list.length; this.list.push(value); this.index.set(value, i); }
    return i;
  }
}

export type WireBootstrapParts = {
  wire: typeof BOOTSTRAP_WIRE_VERSION;
  dict: string[];
  nodes: Row[];
  attributes: Row[];
  attribute_groups: unknown[];
};

/** Encode the node and attribute rows of a lean bootstrap for `workspaceId`.
 *  Spread the result into the payload in place of `nodes` / `attributes`. */
export function encodeBootstrapNodes(workspaceId: string, nodeRows: readonly Row[], attributeRows: readonly Row[]): WireBootstrapParts {
  const dict = new Dict();
  const nodes = nodeRows.map((row) => encodeNode(workspaceId, row, dict));

  const nodeIndex = new Map<string, number>();
  nodeRows.forEach((row, i) => nodeIndex.set(String(row.id), i));
  const groups = new Map<number, unknown[]>();
  const loose: Row[] = [];
  for (const a of attributeRows) {
    const at = nodeIndex.get(String(a.node_id));
    if (at === undefined) { loose.push(a); continue; }
    const tuple = [
      dict.ref(String(a.key)), a.value,
      a.value_type == null ? null : dict.ref(String(a.value_type)),
      a.is_inheritable == null ? null : a.is_inheritable ? 1 : 0,
      a.source == null ? null : dict.ref(String(a.source)),
    ];
    const group = groups.get(at);
    if (group) group.push(tuple); else groups.set(at, [tuple]);
  }
  return { wire: BOOTSTRAP_WIRE_VERSION, dict: dict.list, nodes, attributes: loose, attribute_groups: [...groups] };
}

function encodeNode(workspaceId: string, row: Row, dict: Dict): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (key === "workspace_id" && value === workspaceId) continue;
    if (key === "hidden" && value === false) continue;
    if (key === "order_stamp" && value === "") continue;
    if (key === "source_type" && value === "manual") continue;
    if (key === "node_type" && value === "content") continue;
    if ((DICT_SCALARS as readonly string[]).includes(key)) { out[key] = dict.ref(String(value)); continue; }
    if ((DICT_LISTS as readonly string[]).includes(key)) {
      const list = value as unknown[];
      if (list.length > 0) out[key] = list.map((v) => dict.ref(String(v)));
      continue;
    }
    out[key] = value;
  }
  return out;
}
