import { attributeValues } from "@onden/markdown";
import type { ContentNode, SchemaField } from "./api";
import { t } from "./i18n";

/** A field's value as plain text, for showing it without its editor (a person who may read
 *  but not change it, the fields under a note's title): a linked note by its title, never its id. */
export function readOnlyFieldText(field: SchemaField, value: string, allNodes: readonly ContentNode[]): string {
  return attributeValues(value).map((item) => {
    if (field.type === "relation") return allNodes.find((n) => n.id === item)?.title ?? t("Unknown note");
    if (field.type === "boolean") return item === "true" || item === "1" ? "✓" : "✗";
    if (field.type === "rating") return "★".repeat(Math.max(0, Math.min(Number(item) || 0, field.max ?? 5)));
    return item;
  }).filter(Boolean).join(", ");
}

