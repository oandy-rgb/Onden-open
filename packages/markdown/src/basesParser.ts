// F3.2 — Obsidian-Bases-spec YAML parser (MVP subset).
//
// Parses the YAML body of a base node into a BaseSpec AST. Scope for now:
//   - top-level `filters` (and: [], or: [], not: [], or single-string)
//   - top-level `views: [...]` each with type / name / order / filters /
//     limit / groupBy
//   - `formulas` / `properties` / `summaries` accepted but stored opaquely
//     (rendered later in F3.x — parsing them is YAGNI until eval needs them)
//
// Filter strings are kept as raw text strings here; basesEval.ts compiles
// + executes them against a node. That split keeps the parser pure (only
// JSON-like YAML decoding) and the eval layer testable in isolation.
//
// Why a hand-rolled mini YAML parser: js-yaml is 70+KB. The Bases dialect
// uses a strict subset (no anchors, no tags, no flow style for nested maps)
// that's small enough to write directly. Mirrors the rationale already
// documented in OndenQueryBlock.tsx for its own tiny query DSL.

export type FilterNode =
  | { kind: "leaf"; expr: string }
  | { kind: "and"; items: FilterNode[] }
  | { kind: "or"; items: FilterNode[] }
  | { kind: "not"; items: FilterNode[] };

export type ViewDef = {
  type: "table" | "cards" | "list" | "map";
  name?: string;
  limit?: number;
  groupBy?: { property: string; direction?: "ASC" | "DESC" };
  filters?: FilterNode;
  order?: string[];
  summaries?: Record<string, string>;
};

export type BaseSpec = {
  filters?: FilterNode;
  formulas?: Record<string, string>;
  properties?: Record<string, Record<string, unknown>>;
  summaries?: Record<string, string>;
  views: ViewDef[];
};

// ── YAML mini-decoder ──────────────────────────────────────────────────
// Indent-driven. Returns a plain JS value (object | array | scalar).
// Supports:
//   - block maps:  key: value  /  key:\n  child: ...
//   - block lists: - item                (also lists of maps via leading `- key: v`)
//   - scalars: number, bool, single/double-quoted strings, bare strings
//   - comments: `# …` (line-comment only)
// Does NOT support: anchors, references, flow style { } [ ], multi-line strings.

type Token = { indent: number; line: string };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Strip inline comments unless inside quotes — for the Bases subset,
    // quoted strings always end on the same line so we can use a simple
    // quote-aware scan.
    let inQuote: false | "'" | '"' = false;
    let cleaned = raw;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (!inQuote && (ch === "'" || ch === '"')) { inQuote = ch as "'" | '"'; continue; }
      if (inQuote && ch === inQuote) { inQuote = false; continue; }
      if (!inQuote && ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
        cleaned = raw.slice(0, i).trimEnd();
        break;
      }
    }
    if (!cleaned.trim()) continue;
    const match = /^(\s*)(.*)$/.exec(cleaned)!;
    out.push({ indent: match[1].length, line: match[2] });
  }
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // YAML flow-style list: [a, b, c]. Used in Bases `order: [name, year]`.
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return t;
}

function parseBlock(tokens: Token[], start: number, baseIndent: number): { value: unknown; end: number } {
  if (start >= tokens.length) return { value: null, end: start };

  const first = tokens[start];
  if (first.indent < baseIndent) return { value: null, end: start };

  // List form: starts with `- `.
  if (first.line.startsWith("- ") || first.line === "-") {
    const items: unknown[] = [];
    let i = start;
    while (i < tokens.length && tokens[i].indent === first.indent && (tokens[i].line.startsWith("- ") || tokens[i].line === "-")) {
      const inner = tokens[i].line === "-" ? "" : tokens[i].line.slice(2);
      // If the dash-line is `- key: value` it's a map element whose first
      // key sits on the same line; subsequent keys (if any) are indented
      // further than the dash.
      if (inner.includes(":") && !inner.match(/^["'].*["']$/)) {
        // Build a synthetic token list: replace this line with `key: value`
        // at indent +2, then parse the next contiguous indented block as a
        // single map.
        const synthetic: Token[] = [{ indent: tokens[i].indent + 2, line: inner }];
        let j = i + 1;
        while (j < tokens.length && tokens[j].indent > tokens[i].indent) {
          synthetic.push(tokens[j]);
          j++;
        }
        const sub = parseBlock(synthetic, 0, tokens[i].indent + 2);
        items.push(sub.value);
        i = j;
      } else if (inner === "") {
        // `- ` on its own — the value is a nested block on next lines.
        let j = i + 1;
        const subTokens: Token[] = [];
        while (j < tokens.length && tokens[j].indent > tokens[i].indent) {
          subTokens.push(tokens[j]);
          j++;
        }
        if (subTokens.length === 0) {
          items.push(null);
        } else {
          items.push(parseBlock(subTokens, 0, subTokens[0].indent).value);
        }
        i = j;
      } else {
        items.push(parseScalar(inner));
        i++;
      }
    }
    return { value: items, end: i };
  }

  // Map form: `key: value` or `key:` (with nested block).
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < tokens.length && tokens[i].indent === first.indent && !tokens[i].line.startsWith("- ")) {
    const line = tokens[i].line;
    const colonIdx = colonSplitPoint(line);
    if (colonIdx < 0) { i++; continue; }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === "") {
      // Nested block.
      let j = i + 1;
      const childTokens: Token[] = [];
      while (j < tokens.length && tokens[j].indent > tokens[i].indent) {
        childTokens.push(tokens[j]);
        j++;
      }
      if (childTokens.length === 0) {
        out[key] = null;
      } else {
        out[key] = parseBlock(childTokens, 0, childTokens[0].indent).value;
      }
      i = j;
    } else {
      out[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: out, end: i };
}

// Find the colon that delimits a YAML key:value, skipping colons inside
// quoted strings (the filter-expression strings frequently contain
// `key == "value"` shapes; we want the OUTER colon, not the inner ones).
function colonSplitPoint(line: string): number {
  let inQuote: false | "'" | '"' = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inQuote && (ch === "'" || ch === '"')) { inQuote = ch as "'" | '"'; continue; }
    if (inQuote && ch === inQuote) { inQuote = false; continue; }
    if (!inQuote && ch === ":") return i;
  }
  return -1;
}

export function parseYaml(text: string): unknown {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  return parseBlock(tokens, 0, tokens[0].indent).value;
}

// ── Filter tree decoder ────────────────────────────────────────────────

function decodeFilter(input: unknown): FilterNode | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return { kind: "leaf", expr: input };
  if (Array.isArray(input)) {
    // Bare list under `filters` is implicit AND, per the Bases SKILL.md
    // examples that show `filters: - 'a' - 'b'` as AND.
    return { kind: "and", items: input.map(decodeFilter).filter(Boolean) as FilterNode[] };
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const op of ["and", "or", "not"] as const) {
      if (op in obj) {
        const items = Array.isArray(obj[op]) ? (obj[op] as unknown[]).map(decodeFilter).filter(Boolean) as FilterNode[] : [];
        return { kind: op, items };
      }
    }
  }
  return undefined;
}

function decodeView(raw: unknown, index: number): ViewDef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = (obj.type ?? "table") as ViewDef["type"];
  if (!["table", "cards", "list", "map"].includes(type)) {
    // Fail-soft: one bad view shouldn't kill the whole base. Caller can
    // detect the dropped view by comparing spec.views.length to its YAML
    // source. Aligns with SKILL.md "Validate" workflow (warn, keep going).
     
    console.warn(`base view #${index}: unknown view type "${type}" — skipping`);
    return undefined;
  }
  const view: ViewDef = { type };
  if (typeof obj.name === "string") view.name = obj.name;
  if (typeof obj.limit === "number") view.limit = obj.limit;
  if (obj.groupBy && typeof obj.groupBy === "object") {
    const g = obj.groupBy as Record<string, unknown>;
    if (typeof g.property === "string") {
      view.groupBy = { property: g.property };
      if (g.direction === "ASC" || g.direction === "DESC") view.groupBy.direction = g.direction;
    }
  }
  const f = decodeFilter(obj.filters);
  if (f) view.filters = f;
  if (Array.isArray(obj.order)) view.order = (obj.order as unknown[]).filter((x): x is string => typeof x === "string");
  if (obj.summaries && typeof obj.summaries === "object") view.summaries = obj.summaries as Record<string, string>;
  return view;
}

export function parseBaseSpec(text: string): BaseSpec {
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object") {
    return { views: [] };
  }
  const root = raw as Record<string, unknown>;
  const spec: BaseSpec = { views: [] };
  const globalFilter = decodeFilter(root.filters);
  if (globalFilter) spec.filters = globalFilter;
  if (root.formulas && typeof root.formulas === "object") spec.formulas = root.formulas as Record<string, string>;
  if (root.properties && typeof root.properties === "object") spec.properties = root.properties as Record<string, Record<string, unknown>>;
  if (root.summaries && typeof root.summaries === "object") spec.summaries = root.summaries as Record<string, string>;
  if (Array.isArray(root.views)) {
    root.views.forEach((v, i) => {
      const view = decodeView(v, i);
      if (view) spec.views.push(view);
    });
  }
  return spec;
}
