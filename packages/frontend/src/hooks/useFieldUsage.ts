// P2 migration preview, the one flow for "remove a field that notes use":
// the tag's delete preview gives each field's values count; removing a field
// with values (or whose count we could not read) asks first. The tag page's
// SchemaEditor (TagsPanel) and field list both go through here, so neither can
// drop a populated field silently.

import { useEffect, useState } from "react";
import { reads } from "../lib/data";

/** Per-field count of notes carrying a value. `null` = UNKNOWN (still
 *  loading, or the fetch failed): treated as NOT safe, never as "unused". */
export type FieldUsage = Record<string, number> | null;

type UsagePreview = { fields: Array<{ name: string; values_count: number }> };

/** The field usage of the tag `tagId` (a collection's id is its tag's id).
 *  `undefined` while there is no tag yet (a new collection): nothing to
 *  count, no gate. */
export function useFieldUsage(tagId: string | undefined): FieldUsage | undefined {
  const [usage, setUsage] = useState<FieldUsage>(null);
  useEffect(() => {
    if (!tagId) return;
    let live = true;
    setUsage(null);
    reads.tags.deletePreview<UsagePreview>(tagId)
      .then((p) => { if (live) setUsage(Object.fromEntries(p.fields.map((f) => [f.name, f.values_count]))); })
      .catch(() => { if (live) setUsage(null); /* explicit unknown — editor shows it */ });
    return () => { live = false; };
  }, [tagId]);
  return tagId ? usage : undefined;
}
