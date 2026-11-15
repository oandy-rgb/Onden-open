// The SHAPE of a JSON response: keys, value types, nullability and array
// element shape, never values. apiContract.integration.test.ts records one per
// route into packages/markdown/contract/api-shapes.json; the frontend test
// (frontend src/test/apiContract.test.ts) reads that file. The file format is
// described in packages/markdown/contract/README.md.
//
//   scalar          "string" | "number" | "boolean" | "null", or a union "null|string"
//   object          { "id": "string", "parent_id": "null|string", "note?": "string" }   (a "?" key is absent in some sample)
//   array           [ elementShape ]          ([ "unknown" ] when every sample was empty)
//   mixed container { "$kinds": "array|null", "$items": …, ...props }   (also object-or-null)
//   free-form map   { "$map": valueShape }    (keys depend on data, not on the API)

export type WireShape = string | WireShape[] | { [key: string]: WireShape | boolean };

type Acc = {
  kinds: Set<string>;
  props?: Map<string, { acc: Acc; seen: number }>;
  objects: number;
  items?: Acc;
  map?: Acc;
};

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Object properties whose keys are user data (attribute names, event
 *  payload keys, a tag schema's own document), not part of the API. */
export const FREE_FORM_KEYS = new Set(["attrs", "payload", "tx_meta", "presentation", "tag_schema", "collection_views", "buckets"]);

const newAcc = (): Acc => ({ kinds: new Set(), objects: 0 });

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

function add(acc: Acc, value: unknown, key: string | null): void {
  const kind = kindOf(value);
  acc.kinds.add(kind);
  if (kind === "array") {
    acc.items ??= newAcc();
    for (const item of value as unknown[]) add(acc.items, item, null);
  } else if (kind === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if ((key !== null && FREE_FORM_KEYS.has(key)) || entries.some(([k]) => UUID_KEY.test(k))) {
      acc.map ??= newAcc();
      for (const [, v] of entries) add(acc.map, v, null);
      return;
    }
    acc.objects++;
    acc.props ??= new Map();
    for (const [k, v] of entries) {
      const slot = acc.props.get(k) ?? { acc: newAcc(), seen: 0 };
      slot.seen++;
      add(slot.acc, v, k);
      acc.props.set(k, slot);
    }
  }
}

function render(acc: Acc): WireShape {
  const kinds = [...acc.kinds].sort();
  const scalar = kinds.filter((k) => k !== "object" && k !== "array");
  const container = kinds.filter((k) => k === "object" || k === "array");
  if (container.length === 0) return scalar.join("|");
  const body: { [key: string]: WireShape | boolean } = {};
  if (acc.props || acc.map) {
    if (acc.map) body.$map = render(acc.map);
    for (const [k, slot] of [...(acc.props ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      body[slot.seen < acc.objects ? `${k}?` : k] = render(slot.acc);
    }
  }
  const items = acc.items ? (acc.items.kinds.size === 0 ? "unknown" : render(acc.items)) : "unknown";
  if (container.length === 1 && scalar.length === 0) {
    return container[0] === "array" ? [items] : body;
  }
  return { $kinds: kinds.join("|"), ...(acc.items ? { $items: items } : {}), ...body };
}

/** The shape of `samples` merged into one: for several samples of one route
 *  (an array's elements, the owner's and a member's response). */
export function shapeOf(...samples: unknown[]): WireShape {
  const acc = newAcc();
  for (const sample of samples) add(acc, sample, null);
  return render(acc);
}
