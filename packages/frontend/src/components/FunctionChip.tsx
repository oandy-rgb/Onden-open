import { useT } from "../lib/i18n";
import { MODULES } from "../modules";
import type { Tag } from "../lib/api";
import "./FunctionChip.css";

// A function (a module tag, tag.schema_module) is no tag of the person's own,
// so it is never written "#名稱": its icon and its translated name, in a chip.
// One component for every place that lists a function (the module library,
// the tag page, the note's tag cards…). A person's own tags keep their #.

/** The chip of the function behind a module tag (`tag.schema_module`). */
export default function FunctionChip({ tag }: { tag: Pick<Tag, "name" | "schema_module"> }) {
  const t = useT();
  const mod = tag.schema_module ? MODULES.find((m) => m.id === tag.schema_module) : undefined;
  const Icon = mod?.library.Icon;
  return (
    <span className="function-chip" data-function={tag.schema_module ?? undefined}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {mod ? t(mod.library.title) : t(tag.name)}
    </span>
  );
}

/** A tag's name where tags are listed together: a function is its chip, the
 *  person's own tag is `#name`. */
export function TagName({ tag }: { tag: Pick<Tag, "name" | "schema_module"> }) {
  return tag.schema_module ? <FunctionChip tag={tag} /> : <>#{tag.name}</>;
}
