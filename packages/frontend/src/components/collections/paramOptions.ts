import type { FieldDef } from "../../lib/api";
import { t as tr } from "../../lib/i18n";
import { VIEW_MODULES, type ViewModuleSpec } from "../../modules";

const fieldKey = (field: FieldDef) => field.name ?? field.key ?? "";

/** The view layouts' names, for sentences that list them (generated from the
 *  view modules, so a new layout needs no new text). */
export function layoutNames(): string {
  return VIEW_MODULES.map((mod) => tr(mod.library.title).toLowerCase()).join(tr(", "));
}

/** The fields a view module offers for its one question: its types first,
 *  then (unless it takes only those) the rest; then its built-in columns.
 *  Labels of built-ins are i18n keys. Also used to change it later. */
export function paramOptions(param: NonNullable<ViewModuleSpec["param"]>, fields: FieldDef[]): Array<{ key: string; label: string; builtIn?: boolean }> {
  const named = fields.filter((f) => fieldKey(f) && f.type !== "relation");
  const preferred = named.filter((f) => param.types.includes(f.type));
  const others = param.onlyTypes ? [] : named.filter((f) => !param.types.includes(f.type));
  return [
    ...[...preferred, ...others].map((f) => ({ key: fieldKey(f), label: f.label || fieldKey(f) })),
    ...(param.builtIns ?? []).map((b) => ({ key: b.key, label: b.label, builtIn: true })),
  ];
}
