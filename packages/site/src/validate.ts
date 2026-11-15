// validateDesign: any stored value → a SiteDesign that satisfies the registry
// and the nesting rules (design doc §5.1). Never throws: what cannot be kept
// is dropped or clamped and reported in `problems` (for tests and logs).
import { BLOCK_ID } from "@onden/markdown/block-id";
import { isHexColor } from "@onden/markdown";
import { ARTICLE_FRAME_KEYS, DEFAULT_DATE_TAGS, TAG_FRAME_KEYS, defaultDesignV2, defaultFrames, type DefaultDesignInput } from "./defaults.js";
import { isObj } from "./isObj.js";
import { bracesBalanced, SITE_CSS_MAX } from "./css.js";
import type { PuckComponentData, SiteDesignV2, SiteFrames, SiteStyle } from "./design.js";
import {
  COMPONENTS_MAX, REF_MAX, allowedAt, kindOf, propSpecsOf, slotsOf, usedSlots, type Place, type PropSpec,
} from "./registry.js";
import { DEFAULT_ACCENT, SCHEMES, STYLE_PRESET_NAMES } from "./style.js";

export type DesignValidationV2 = { design: SiteDesignV2; problems: string[] };

type Obj = Record<string, unknown>;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validateDesignV2(input: unknown, fallback: DefaultDesignInput = {}): DesignValidationV2 {
  if (!isObj(input) || input.v !== 2) {
    return { design: defaultDesignV2(fallback), problems: ["not a v2 design: using the default design"] };
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  let count = 0;

  const freshId = (type: string) => {
    for (let n = 1; ; n++) {
      const id = `${type}-${n}`;
      if (!ids.has(id)) return id;
    }
  };

  const cleanProp = (type: string, name: string, spec: PropSpec, raw: unknown): unknown => {
    const where = `${type}.${name}`;
    switch (spec.kind) {
      case "enum":
        if (typeof raw === "string" && spec.values.includes(raw)) return raw;
        if (raw !== undefined) problems.push(`${where}: "${String(raw)}" is not allowed, using "${spec.default}"`);
        return spec.default;
      case "int": {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          if (raw !== undefined) problems.push(`${where}: not a number, using ${spec.default}`);
          return spec.default;
        }
        const n = clamp(Math.round(raw), spec.min, spec.max);
        if (n !== raw) problems.push(`${where}: ${raw} clamped to ${n}`);
        return n;
      }
      case "cls": {
        if (typeof raw !== "string") return "";
        const cleaned = raw.replace(/[^A-Za-z0-9_ -]/g, "").slice(0, spec.max);
        if (cleaned !== raw) problems.push(`${where}: class name cleaned`);
        return cleaned;
      }
      case "css": {
        if (typeof raw !== "string") return "";
        if (raw.length > spec.max) {
          problems.push(`${where}: CSS over ${spec.max} characters, dropped`);
          return "";
        }
        if (!bracesBalanced(raw)) problems.push(`${where}: CSS braces do not balance, it will not be applied`);
        return raw;
      }
      case "ref":
        // eslint-disable-next-line no-control-regex
        return typeof raw === "string" ? raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, REF_MAX).trim() : "";
      case "blockId": {
        if (typeof raw !== "string") return "";
        const id = raw.replace(/^\^/, "");
        if (id === "") return "";
        if (BLOCK_ID.test(id)) return id;
        problems.push(`${where}: not a block id, dropped`);
        return "";
      }
    }
  };

  /** One component, or null when it is dropped. `place` is where the caller
   *  wants to put it. */
  const cleanComponent = (raw: unknown, place: Place): PuckComponentData | null => {
    if (!isObj(raw) || typeof raw.type !== "string") {
      problems.push("a component without a type was dropped");
      return null;
    }
    const type = raw.type;
    const kind = kindOf(type);
    if (!kind) {
      problems.push(`unknown component type "${type}" dropped`);
      return null;
    }
    if (!allowedAt(place, type)) {
      problems.push(`${type} is not allowed ${place === "outer" ? "inside a top-level part" : "inside an inner part"}, dropped`);
      return null;
    }
    if (count >= COMPONENTS_MAX) {
      problems.push(`more than ${COMPONENTS_MAX} components, ${type} dropped`);
      return null;
    }
    count++;
    const rawProps = isObj(raw.props) ? raw.props : {};
    const id = typeof rawProps.id === "string" && NODE_ID.test(rawProps.id) && !ids.has(rawProps.id) ? rawProps.id : freshId(type);
    if (id !== rawProps.id) problems.push(`${type}: id missing, invalid or repeated, now "${id}"`);
    ids.add(id);

    const props: PuckComponentData["props"] = { id };
    const specs = propSpecsOf(type);
    for (const [name, spec] of Object.entries(specs)) props[name] = cleanProp(type, name, spec, rawProps[name]);

    const slots = slotsOf(type);
    const used = usedSlots(type, props);
    const childPlace: Place = place === "top" && kind === "part" ? "outer" : "inner";
    for (const name of slots) {
      const list = rawProps[name];
      if (!used.includes(name)) {
        if (Array.isArray(list) && list.length > 0) problems.push(`${type}.${name}: slot is past count, its content was dropped`);
        props[name] = [];
        continue;
      }
      props[name] = Array.isArray(list) ? list.flatMap((item) => cleanComponent(item, childPlace) ?? []) : [];
    }
    const known = new Set(["id", ...Object.keys(specs), ...slots]);
    const extra = Object.keys(rawProps).filter((k) => !known.has(k));
    if (extra.length > 0) problems.push(`${type}: unknown props dropped (${extra.join(", ")})`);
    return { type, props };
  };

  const rawContent = isObj(input.home) && Array.isArray(input.home.content) ? input.home.content : [];
  const content: PuckComponentData[] = [];
  for (const raw of rawContent) {
    const component = cleanComponent(raw, "top");
    if (component) content.push(component);
  }

  const design: SiteDesignV2 = {
    v: 2,
    rev: typeof input.rev === "string" ? input.rev : "",
    studio_draft: true,
    home: { root: { props: {} }, content },
    style: cleanStyle(input.style, problems),
    css: cleanSiteCss(input.css, problems),
    frames: cleanFrames(input.frames),
  };
  return { design, problems };
}

export function cleanSiteCss(raw: unknown, problems: string[]): string {
  if (typeof raw !== "string") return "";
  if (raw.length > SITE_CSS_MAX) {
    problems.push(`site CSS over ${SITE_CSS_MAX} characters, dropped`);
    return "";
  }
  if (!bracesBalanced(raw)) problems.push("site CSS braces do not balance, it will not be applied");
  return raw;
}

/** The stored style → the current one. A design saved before the three-choice
 *  style keeps its preset name (any other value is 安靜) and accent; its size,
 *  ratio, density, fonts and radius are dropped, now computed from the preset. */
export function cleanStyle(raw: unknown, problems: string[]): SiteStyle {
  if (!isObj(raw)) return { preset: "quiet", accent: DEFAULT_ACCENT, scheme: "system" };
  if (typeof raw.accent === "string" && !isHexColor(raw.accent)) problems.push(`style.accent "${raw.accent}" is not #rrggbb`);
  return {
    preset: STYLE_PRESET_NAMES.find((name) => name === raw.preset) ?? "quiet",
    accent: typeof raw.accent === "string" && isHexColor(raw.accent) ? raw.accent.toLowerCase() : DEFAULT_ACCENT,
    scheme: SCHEMES.find((scheme) => scheme === raw.scheme) ?? "system",
  };
}

export function cleanFrames(raw: unknown): SiteFrames {
  const frames = defaultFrames();
  if (!isObj(raw)) return frames;
  const apply = (target: Record<string, boolean>, source: unknown, keys: readonly string[]) => {
    if (!isObj(source)) return;
    for (const key of keys) if (typeof source[key] === "boolean") target[key] = source[key];
  };
  apply(frames.article, raw.article, ARTICLE_FRAME_KEYS);
  apply(frames.tag, raw.tag, TAG_FRAME_KEYS);
  if (Array.isArray(raw.date_tags)) {
    frames.date_tags = [...new Set(raw.date_tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 60).trim()).filter(Boolean))].slice(0, 20);
  } else frames.date_tags = [...DEFAULT_DATE_TAGS];
  return frames;
}
