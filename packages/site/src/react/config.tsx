// The Puck config for the home page: one component per registry entry, fields
// and `allow` lists that implement the nesting rules, Chinese labels, patterns
// that pre-fill their slots. Imports Puck as types only; the render components
// are in render.tsx and run under react-dom/server.
import type { ComponentConfig, Config, Field, Fields } from "@puckeditor/core";
import {
  CONTENT, CONTENT_TYPES, INNER_SLOT_ALLOW, OUTER_SLOT_ALLOW, PARTS, PART_TYPES, PATTERNS, PATTERN_TYPES,
  partTypeOf, propSpecsOf, slotsOf, usedSlots, type ComponentType, type PropSpec,
} from "../registry.js";
import { patternDefaultSlots } from "../patterns.js";
import { CATEGORY_LABELS, COMPONENT_LABELS, FIELD_LABELS, OPTION_LABELS, WIDTH_LABELS } from "./labels.js";
import { NoteView, Timeline, TagView, renderPartOrPattern, type RenderProps } from "./render.js";

export type CreatePuckConfigOptions = {
  /** Pickers for ids; plain text fields until P3 swaps in external fields over local data. */
  fields?: { note?: Field; tag?: Field; view?: Field };
};

const optionsOf = (type: string, name: string, values: readonly string[]) => {
  const labels = name === "width" ? WIDTH_LABELS[partTypeOf(type) ?? ""] : OPTION_LABELS[name];
  return values.map((value) => ({ value, label: labels?.[value] ?? value }));
};

function fieldFor(type: string, name: string, spec: PropSpec, opts: CreatePuckConfigOptions): Field {
  const label = FIELD_LABELS[name] ?? name;
  switch (spec.kind) {
    case "enum":
      return { type: "radio", label, options: optionsOf(type, name, spec.values) };
    case "int":
      return { type: "number", label, min: spec.min, max: spec.max };
    case "css":
      return { type: "textarea", label };
    case "ref": {
      const picker = name === "noteId" ? opts.fields?.note : name === "tagId" ? opts.fields?.tag : opts.fields?.view;
      return picker ?? { type: "text", label };
    }
    default:
      return { type: "text", label };
  }
}

/** The fields of a component. `slotAllow` is what its slots may hold. */
function fieldsFor(type: string, slotAllow: readonly ComponentType[], opts: CreatePuckConfigOptions, props?: Record<string, unknown>): Fields {
  const fields: Record<string, Field> = {};
  for (const [name, spec] of Object.entries(propSpecsOf(type))) fields[name] = fieldFor(type, name, spec, opts);
  const slots = props ? usedSlots(type, props) : slotsOf(type);
  for (const name of slots) fields[name] = { type: "slot", label: FIELD_LABELS[name] ?? name, allow: [...slotAllow] };
  return fields as Fields;
}

function defaultPropsOf(type: ComponentType): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(propSpecsOf(type))) {
    props[name] = spec.kind === "enum" || spec.kind === "int" ? spec.default : "";
  }
  for (const slot of slotsOf(type)) props[slot] = [];
  if (type in PATTERNS) {
    const pattern = type as keyof typeof PATTERNS;
    Object.assign(props, PATTERNS[pattern].props, patternDefaultSlots(pattern));
  }
  for (const [name, spec] of Object.entries(CONTENT[type as keyof typeof CONTENT]?.props ?? {})) if (spec.kind === "ref") props[name] = "";
  return props;
}

/** Puck `resolveFields` for a part or pattern: the slots of an inner part (one
 *  that has a parent) and of a pattern hold content only, and a switcher shows
 *  just its first `count` slots. The static `fields` allow the top-level case.
 *  Note: Puck 0.23 takes a drop's slot `allow` from the static `fields` only, so
 *  this narrowing is not enforced when dragging; the studio enforces the depth
 *  rules on the data instead (frontend studio/designModel.ts nestingViolation). */
function resolveFields(type: ComponentType, opts: CreatePuckConfigOptions) {
  return (data: { props: Record<string, unknown> }, { parent }: { parent: unknown }): Fields => {
    const isPattern = type in PATTERNS;
    return fieldsFor(type, isPattern || parent ? INNER_SLOT_ALLOW : OUTER_SLOT_ALLOW, opts, data.props);
  };
}

export function createPuckConfig(opts: CreatePuckConfigOptions = {}): Config {
  const components: Record<string, ComponentConfig<any>> = {};

  for (const type of PART_TYPES) {
    components[type] = {
      label: COMPONENT_LABELS[type],
      fields: fieldsFor(type, OUTER_SLOT_ALLOW, opts),
      defaultProps: defaultPropsOf(type),
      resolveFields: resolveFields(type, opts) as never,
      render: (props: RenderProps) => <>{renderPartOrPattern(type, props)}</>,
    };
  }
  for (const type of PATTERN_TYPES) {
    components[type] = {
      label: COMPONENT_LABELS[type],
      fields: fieldsFor(type, INNER_SLOT_ALLOW, opts),
      defaultProps: defaultPropsOf(type),
      resolveFields: resolveFields(type, opts) as never,
      render: (props: RenderProps) => <>{renderPartOrPattern(type, props)}</>,
    };
  }
  const content: Record<(typeof CONTENT_TYPES)[number], (props: RenderProps) => React.ReactNode> = {
    note: NoteView, tag_view: TagView, timeline: Timeline,
  };
  for (const type of CONTENT_TYPES) {
    components[type] = {
      label: COMPONENT_LABELS[type],
      fields: fieldsFor(type, [], opts),
      defaultProps: defaultPropsOf(type),
      render: (props: RenderProps) => <>{content[type](props)}</>,
    };
  }
  return {
    components,
    categories: {
      patterns: { title: CATEGORY_LABELS.patterns, components: [...PATTERN_TYPES] },
      parts: { title: CATEGORY_LABELS.parts, components: [...PART_TYPES] },
      content: { title: CATEGORY_LABELS.content, components: ["note", "tag_view"] },
      modules: { title: CATEGORY_LABELS.modules, components: ["timeline"] },
    },
  } as Config;
}
