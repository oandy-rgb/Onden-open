import { runBackgroundWrite } from "../../lib/data";
// Multi-value editor — for fields with cardinality="many", and for a list
// stored under a text or relation field (SchemaRow decides which).
//
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.
//
// Stores a JSON array of strings as the attribute value. On render we parse
// the array, render one inline widget per slot (reusing the same SchemaRow
// machinery via a single-value sub-field), plus a "+" to append. Save fires
// the JSON-serialised array back as a single attribute write.

import { useMemo } from "react";
import { attributeValues, encodeValues } from "@onden/markdown";
import { Plus, X } from "lucide-react";
import type { ContentNode, SchemaField } from "../../lib/api";
import { SchemaRow } from "./SchemaRow";
import { useT } from "../../lib/i18n";
import { Pressable } from "../ui";

export function MultiValueEditor({
  field, value, allNodes, onSave,
}: {
  field: SchemaField;
  value: string;
  allNodes: ContentNode[];
  onSave: (next: string) => Promise<void> | void;
}) {
  const t = useT();
  // The one codec (@onden/markdown attributeValues, D117): a single value
  // (stored before the field became 'many') is a one-slot list, so user data
  // isn't blown away by a parse error.
  const items = useMemo<string[]>(() => attributeValues(value), [value]);

  const writeBack = (next: string[]) => onSave(encodeValues(next));

  const singleField: SchemaField = { ...field, cardinality: "one" };

  return (
    <div className="attr-multi-editor">
      {items.length === 0 && (
        <div className="attr-multi-empty"><em>{t("empty")}</em></div>
      )}
      {items.map((item, idx) => (
        <div key={idx} className="attr-multi-row">
          <div className="attr-multi-slot">
            <SchemaRow
              field={singleField}
              value={item}
              allNodes={allNodes}
              onSave={(next) => writeBack(items.map((it, i) => i === idx ? String(next) : it))}
            />
          </div>
          <Pressable
            className="attr-multi-remove"
            onClick={() => runBackgroundWrite(writeBack(items.filter((_, i) => i !== idx)))}
            title={t("Remove this entry")}
            aria-label={t("Remove")}
          >
            <X size={11} />
          </Pressable>
        </div>
      ))}
      <Pressable
        className="attr-multi-add"
        onClick={() => runBackgroundWrite(writeBack([...items, ""]))}
        title={t("Add another")}
      >
        <Plus size={11} /> {t("Add")}
      </Pressable>
    </div>
  );
}
