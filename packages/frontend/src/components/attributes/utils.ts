// Shared helpers + types for the schema-driven attributes panel.
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.

import { EDITOR_STORAGE_ATTR_KEYS } from "@onden/markdown";
import { t } from "../../lib/i18n";

// A field's storage type (storageType) and a new key's inferred field type
// (inferFieldType) are @onden/markdown attributeValue — the server stores by
// the same rule.

/** Attributes the editors store for their own content: drawn on the page, never listed as a field.
 *  The list is @onden/markdown's (isShownPropertyKey asks it too). */
export const INTERNAL_ATTRIBUTE_KEYS: ReadonlySet<string> = EDITOR_STORAGE_ATTR_KEYS;

export type InheritedAttr = {
  key: string;
  value: string;
  value_type: string;
  source_node_id: string;
  source_node_title: string;
  depth: number;
};

export type RollupAttr = {
  key: string;
  label: string;
  value: number;
  op: string;
  tag: string | null;
  attr: string | null;
};

/** A sentence for what a calculated row counts or reads, in the interface language. */
export function rollupDescription(r: Pick<RollupAttr, "op" | "tag" | "attr">): string {
  if (r.op === "count") return r.tag ? t("count of items below tagged #{tag}", { tag: r.tag }) : t("count of items below");
  const op = r.op === "sum" ? t("sum") : r.op === "max" ? t("largest") : t("smallest");
  return r.tag ? t("{op} of {attr} from items below tagged #{tag}", { op, attr: r.attr ?? "", tag: r.tag }) : t("{op} of {attr} from items below", { op, attr: r.attr ?? "" });
}
