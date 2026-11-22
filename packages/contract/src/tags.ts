// Tags as the server sends them (GET /api/tags, the bootstrap, the sync delta) and the fields their schemas declare.
// Pure types: the app imports them with `import type`, so nothing here may run.

// THE schema field definition — TagsPanel/SchemaLens import (and TagsPanel
// re-exports) this same type rather than re-declaring a parallel one.
export type FieldDef = {
  name: string;
  // The backend normalizes field identifiers to `name` (import + PATCH write
  // boundaries; migration 056 backfilled old rows). `key` lingers only in
  // stale cached payloads from before the unification — tolerated on read,
  // never written.
  key?: string;
  label?: string;
  // `rating` is a number under the hood (stored as value_type 'number', so
  // sort/aggregate/filter all keep working) that renders as a star widget.
  type: "text" | "textarea" | "richtext" | "number" | "boolean" | "date" | "select" | "media" | "relation" | "rating";
  required?: boolean;
  options?: string[];
  /** rating fields: the top of the scale / highest star value (default 5).
   *  Stored as a plain number string so sort/rollup treat it like any numeric
   *  attribute; the widget clamps stored numbers to 0..max. */
  max?: number;
  // For relation fields: optionally restrict targets to nodes carrying this
  // class-tag (by name). Legacy JSON key name kept to avoid a jsonb migration.
  relation_supertag?: string;
  /** P2: seeded as a 'derived' attribute when the tag is applied (backend
   *  services/fieldDefaults.ts). Stored as text like every attr value. */
  default?: string;
};

// A class tag IS a content_node with node_type='class_tag' (substrate
// commits A1.1-A1.6). The Tag type kept its existing field names for
// backwards compatibility — the API aliases the underlying columns
// (n.title AS name, n.tag_color AS color, schema_id = node id when tag_schema set)
// so 25+ consumer sites in the frontend don't need to rename.
//
// A1.7: ContentNode-native fields surface optionally — markdown lets a
// tag carry its own description page, created_at/updated_at expose the
// node lifecycle, all routed through the same domain_events / restore /
// trash substrate as regular nodes (the thesis 「心智模型統一」 promise).
//
// A label tag is a content_node with the same node_type but schema_id
// null — nothing fancy on the substrate side; the distinction lives in
// schema_id presence.
export type Tag = {
  id: string;
  name: string;
  /** Role of a system-reserved tag ("task", "workspace-config",
   *  "page"), whatever it is titled; null/absent for ordinary tags. */
  reserved_key?: string | null;
  /** Paragraphs that carry the tag directly, in notes the reader can read (backend tagCatalog; what the tag page lists
   *  as 「段落」). Counts with the notes in a tag's use (frontend lib/nodeTags directTagUsage). Absent from an older server. */
  block_usage_count?: number;
  /** Null for a tag nobody coloured (the catalog sends tag_color as it is stored). */
  color: string | null;
  // Non-null when the tag carries a schema (= "class tag" in substrate-speak:
  // it owns fields / behaviour). Null = plain label tag.
  schema_id: string | null;
  // Schema details inlined into the /api/tags response so consumers (graph
  // colouring, the properties panel) can render schema-driven UI without a
  // second roundtrip. Null when the tag is just a label (no schema).
  schema_fields?: SchemaField[] | null;
  schema_slug?: string | null;
  /** Saved tag capabilities, including `modules`; never inferred from the name. The app reads `modules` through its own
   *  narrower type (lib/tagModules.ts TagModuleBehaviour). */
  schema_behaviour?: Record<string, unknown> | null;
  /** Module library (docs/architecture/module-library.md): the module this tag
   *  is the module tag of (#複習 → "review"), the tags it extends (ids this
   *  actor can see), and the modules it provides — its own plus everything it
   *  extends, at any depth, computed by the server with every tag. Absent from
   *  older servers: then only the module tag and legacy switches count. */
  schema_module?: string | null;
  /** A view module's tag (#月曆…): tags extending it use that view; it has no
   *  members and is never applied to a note (views-as-modules.md V4). */
  view_module?: boolean;
  schema_extends?: string[] | null;
  /** The fields notes with this tag get: its own plus those of the tags it
   *  extends, nearest first (`inherited_from` names the declaring tag),
   *  computed by the server (services/tagFields.ts). Absent from older
   *  servers — read through lib/tagFields.ts, which falls back to the own. */
  effective_fields?: Array<SchemaField & { inherited_from?: string }> | null;
  effective_modules?: string[] | null;
  /** The tag's functions, one per function reference (the server's function_refs): which function, the
   *  tag its settings come from (the tag itself when it has no module tag), and the reference row
   *  (null for a view, which is not a reference yet). Read through hooks/useFunctions. */
  functions?: Array<{ id: string; source_tag_id: string; ref_id: string | null }> | null;
  /** The child notes applying this tag creates (the server's template
   *  expansion, e.g. the Meeting pack's Agenda / Decisions / Action items). */
  schema_template_children?: Array<{ title?: string }> | null;
  /** Hidden by the owner (「隱藏標籤」, D104): the tag keeps working — notes
   *  keep it, its fields, functions, views and filters apply — but it is left
   *  out of tag lists, chips and suggestions (lib/nodeTags.ts isTagShown,
   *  the one rule) and off the published site. Only tags can be hidden. */
  hidden?: boolean;
  // L1 hierarchy. NULL = root.
  parent_id?: string | null;
  // A1.7: ContentNode-native fields. Optional during transition; will be
  // required once L3-A wraps and the legacy `tags` table is dropped.
  markdown?: string;
  created_at?: string;
  updated_at?: string;
};

// FieldDef plus the schema-only extensions. The base shape is shared (one
// type, not a hand-kept parallel copy), so SchemaField[] assigns to
// FieldDef[] without casts.
export type SchemaField = FieldDef & {
  /** Single value or list. Datomic-style — default is 'one'. When 'many',
   *  the value is stored as a JSON array string in node_attributes and the
   *  panel renders a multi-input list widget. */
  cardinality?: "one" | "many";
  /** Synthesized attribute — computed from descendants (Knuth bottom-up).
   *  When present, the panel renders this as a read-only computed value
   *  and the backend's /rollup-attributes endpoint walks the subtree to
   *  produce it. Storage stays empty (no node_attributes row). */
  rollup?: {
    /** Aggregation: count of descendants, sum of an attr, max of an attr.
     *  More ops slot in as use cases drive them. */
    op: "count" | "sum" | "max" | "min";
    /** Optional descendant filter — only count / aggregate descendants
     *  carrying this tag name. */
    tag?: string;
    /** For sum / max / min — the attribute key to aggregate. */
    attr?: string;
  };
};
