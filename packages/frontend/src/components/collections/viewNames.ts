import type { FieldDef } from "../../lib/api";
import { t as tr } from "../../lib/i18n";
import { NOTE_VIEW_MODULES, VIEW_MODULES } from "../../modules";
import type { ViewNameParts } from "../../lib/viewTabs";
import { fieldDisplayName } from "../viewLayoutKit";

// The parts of a view's automatic name (lib/viewTabs nameAfterViewChange): its
// kind's title, and what sets it apart — the field it is placed by (a
// calendar's date, a board's columns), else its first filter. One place, so a
// view added, switched, re-placed or filtered is named by the same rule.

type NamedView = {
  layout: string;
  group_by?: string | null;
  layout_config?: Record<string, unknown> | null;
  filters?: unknown[] | null;
};

export function viewNameParts(view: NamedView, fields: readonly FieldDef[] = []): ViewNameParts {
  const mod = VIEW_MODULES.find((m) => m.id === view.layout);
  const title = tr(mod?.library.title ?? NOTE_VIEW_MODULES.find((m) => m.id === view.layout)?.library.title ?? view.layout);
  const labelOf = (key: string) => fields.find((f) => (f.name ?? f.key) === key)?.label || fieldDisplayName(key, tr);
  const param = mod?.view.param;
  const placed = param ? (param.key === "group_by" ? view.group_by : view.layout_config?.[param.key]) : null;
  // The field is named as the question that placed it names it (「Created date」), else as the page's field.
  const builtIn = param?.builtIns?.find((b) => b.key === placed);
  if (typeof placed === "string" && placed) return { title, qualifier: builtIn ? tr(builtIn.label) : labelOf(placed) };
  const filter = (view.filters?.[0] ?? null) as { field?: string; value?: unknown } | null;
  const said = filter && (typeof filter.value === "string" && filter.value.trim() ? filter.value.trim() : filter.field ? labelOf(filter.field) : "");
  return { title, qualifier: said || null };
}
