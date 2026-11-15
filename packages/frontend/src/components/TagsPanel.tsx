import { numberDefaultFrom, selectOptionsPatch } from "../lib/tagFields";
import { ChevronUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import type { FieldDef } from "../lib/api";
import { t as tr, useT } from "../lib/i18n";
import { alertDialog } from "./ConfirmDialog";
import "./TagsPanel.css";
import "./ObsidianImport.css";
import { Button, Checkbox, Pressable, Select, TextField } from "./ui";
import { reads } from "../lib/data";
import type { FieldUsage } from "../hooks/useFieldUsage";
import { confirmFieldRemoval } from "./confirmFieldRemoval";
import { isAttributeKey, normalizeText, WORD_CHARS, cutToGraphemes } from "@onden/markdown";
import { downloadBlob } from "../lib/download";
import EmptyState from "./EmptyState";

// ── Types ────────────────────────────────────────────────────────────────────

// FieldDef lives in lib/api.ts (it IS the wire shape) — re-exported here so
// the editor's consumers (SchemaLens etc.) keep importing it from TagsPanel.
export type { FieldDef } from "../lib/api";

export type Behaviour = Record<string, unknown>;

type FieldType = FieldDef["type"];

const FIELD_TYPES: FieldType[] = ["text", "textarea", "richtext", "number", "rating", "boolean", "date", "select", "media", "relation"];

// Rollup is a SchemaField extension (not a base wire `type`), but in the editor
// it reads as just another field "kind" — pick "rollup" and you get the op/attr
// config instead of a value editor. We expose it as a pseudo-type in the select
// and translate to/from the real `rollup` object on the field.
const ROLLUP_OPS = ["count", "sum", "max", "min"] as const;
const isRollupField = (f: FieldDef): boolean => !!(f as { rollup?: unknown }).rollup;

// Download a tag as TagPack JSON. Triggers a browser-native file save through
// a blob URL — no extra dependency. The filename uses the tag slug so users
// can dump several at once and tell them apart without opening each.
// (Used by the Tags Library tab — the D6 import/export escape hatch.)
export async function exportTagPack(tag: { id: string; name: string; schema_slug?: string | null }): Promise<void> {
  try {
    const pack = await reads.tags.exportPack(tag.id);
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${tag.schema_slug ?? tag.name}.tagpack.json`);
  } catch {
    await alertDialog(tr("Export failed. Try again."));
  }
}

// ── Schema editor ────────────────────────────────────────────────────────────

// The internal field key (snake_case) is DERIVED from the human label, never
// authored by hand — the surface-no-programmer-ui goal. Notion-style: the key is
// fixed at creation and stays stable when the label is later renamed, so the data
// (markdown #key=value / node_attributes.key) doesn't break. The key follows
// the one attribute key grammar (@onden/markdown isAttributeKey, D44), so it
// survives an export and re-import: a label starting with a digit gets `f_`.
// A label's combining marks stay (`कीमत`, not `क_मत`) and the key is NFC (D58).
const NON_KEY_RUN = new RegExp(`[^${WORD_CHARS}]+`, "gu");
export function fieldKeyFrom(label: string): string {
  const words = normalizeText(label).trim().toLowerCase().replace(NON_KEY_RUN, "_").replace(/^_+|_+$/g, "");
  const key = cutToGraphemes(words, 40).replace(/_+$/, "");
  if (!key) return "field";
  return isAttributeKey(key) ? key : `f_${key}`;
}
function committedKeyOf(f: FieldDef): string { return f.name || f.key || ""; }
/** A field another tag has the name of: `tag` names that tag, `field` the
 *  field as it shows there, `below` whether that tag is under this one. */
export type SchemaFieldClash = { tag: string; field: string; below: boolean };

function uniqueKey(base: string, fields: FieldDef[], selfIdx: number, alsoTaken: readonly string[] = []): string {
  const taken = new Set([...fields.filter((_, i) => i !== selfIdx).map(committedKeyOf), ...alsoTaken]);
  let k = base, n = 2;
  while (taken.has(k)) k = `${base}_${n++}`;
  return k;
}
// A field's key is still "auto" (safe to (re)derive) until a real one is
// committed — under EITHER identifier (`name` or the imported `key`).
const keyIsAuto = (f: FieldDef): boolean => {
  const k = committedKeyOf(f);
  return !k || /^field_\d+$/.test(k);
};

/** One field's settings: name, type, usage, required, the type's own options
 *  and the default. The field list (SchemaEditor) and a field's popover on the
 *  tag page (tagPage/FieldPopover) both edit a field through this; `fields` is
 *  the whole list (a new key must differ from the others) and `patchField`
 *  changes this one. */
export function FieldEditor({ f, idx, fields, patchField, clashes, takenNames = [], fieldUsage }: {
  f: FieldDef; idx: number; fields: FieldDef[];
  patchField: (idx: number, patch: Partial<FieldDef>) => void;
  clashes?: ReadonlyMap<string, SchemaFieldClash>;
  takenNames?: readonly string[];
  fieldUsage?: FieldUsage;
}) {
  const t = useT();
  return (
    <>
      <div className="schema-field-grid">
        <TextField
          className="actors-input"
          placeholder={t("Field name (e.g. Due date)")}
          value={f.label ?? (keyIsAuto(f) ? "" : committedKeyOf(f))}
          onChange={(e) => patchField(idx, { label: e.target.value || undefined })}
          onBlur={() => {
            // Commit a stable key from the label, once, for a new field.
            const label = (f.label ?? "").trim();
            if (label && keyIsAuto(f)) patchField(idx, { name: uniqueKey(fieldKeyFrom(label), fields, idx, takenNames) });
          }}
          title={t("The field's name — shown on every tagged note")}
        />
        <Select
          className="actors-input"
          value={isRollupField(f) ? "rollup" : f.type}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "rollup") {
              // Turn this into a computed (read-only) field. Seed a
              // count rollup; the addenda below let the user pick op/attr.
              patchField(idx, { type: "number", rollup: { op: "count" } } as Partial<FieldDef>);
            } else {
              // Leaving rollup mode drops the rollup config.
              patchField(idx, { type: v as FieldType, rollup: undefined } as Partial<FieldDef>);
            }
          }}
        >
          {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(ft)}</option>)}
          <option value="rollup">{t("Calculated (auto-total)")}</option>
        </Select>
        {(() => {
          if (fieldUsage === null) {
            // The usage fetch failed — say so instead of letting a
            // populated field masquerade as unused.
            return (
              <span className="schema-field-usage schema-field-usage--unknown" title={t("Could not check how many notes use this field — removal will ask for confirmation")}>
                {t("usage unknown")}
              </span>
            );
          }
          const used = fieldUsage?.[committedKeyOf(f)] ?? 0;
          return used > 0 ? (
            <span className="schema-field-usage" title={t("{n} note(s) carry a value for this field — type changes don't rewrite them; removal keeps them as plain properties", { n: used })}>
              {t("{n} in use", { n: used })}
            </span>
          ) : null;
        })()}
        <label className="ui-checkbox schema-field-required" title={t("Field must be set")}>
          <Checkbox
            checked={!!f.required}
            onChange={(e) => patchField(idx, { required: e.target.checked || undefined })}
          />
          <span>{t("required")}</span>
        </label>
      </div>
      {(() => {
        const clash = clashes?.get(committedKeyOf(f));
        return clash && (
          <p className="schema-field-clash" role="alert">
            {clash.below
              ? t("#{tag} below already has the field \"{field}\" — pick another name; this one isn't saved", { tag: clash.tag, field: clash.field })
              : t("#{tag} already gives the field \"{field}\" — pick another name; this one isn't saved", { tag: clash.tag, field: clash.field })}
          </p>
        );
      })()}

      {/* Type-specific addenda */}
      {f.type === "select" && !isRollupField(f) && (
        <TextField
          className="actors-input schema-field-options"
          placeholder={t("options (comma-separated, e.g. todo,doing,done)")}
          value={(f.options ?? []).join(", ")}
          onChange={(e) => patchField(idx, selectOptionsPatch(f, e.target.value.split(",").map((s) => s.trim()).filter(Boolean)))}
        />
      )}
      {/* Rating — how many stars the scale tops out at (default 5). */}
      {f.type === "rating" && !isRollupField(f) && (
        <label className="schema-field-rating-cfg" title={t("The top of the star scale")}>
          <span className="schema-field-default-label">{t("stars")}</span>
          <TextField
            className="actors-input"
            type="number"
            min={1}
            max={10}
            value={(f as { max?: number }).max ?? 5}
            onChange={(e) => {
              const n = Math.max(1, Math.min(10, Number(e.target.value) || 5));
              patchField(idx, { max: n } as Partial<FieldDef>);
            }}
          />
        </label>
      )}
      {/* Rollup — what the computed value aggregates from the subtree.
          op=count needs nothing more; sum/max/min need an attr key.
          Both can scope to descendants carrying a given #tag. Mirrors the
          backend computeRollupAttributes contract (op / attr / tag). */}
      {isRollupField(f) && (() => {
        const rollup = (f as { rollup?: { op?: string; attr?: string; tag?: string } }).rollup ?? { op: "count" };
        const setRollup = (patch: Partial<{ op: string; attr: string; tag: string }>) => {
          const next = { ...rollup, ...patch };
          // Drop empty optional keys so the stored config stays minimal.
          if (!next.attr) delete (next as { attr?: string }).attr;
          if (!next.tag) delete (next as { tag?: string }).tag;
          patchField(idx, { rollup: next } as Partial<FieldDef>);
        };
        const OP_LABELS: Record<string, string> = {
          count: t("Count items"),
          sum: t("Add them up"),
          max: t("Highest"),
          min: t("Lowest"),
        };
        return (
          <div className="schema-field-rollup">
            <p className="schema-field-rollup-help">{t("Automatically totals values from items below.")}</p>
            <Select
              className="actors-input"
              value={rollup.op ?? "count"}
              onChange={(e) => setRollup({ op: e.target.value })}
              title={t("What to calculate")}
            >
              {ROLLUP_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
            </Select>
            {rollup.op !== "count" && (
              <TextField
                className="actors-input"
                placeholder={t("Add up these values (e.g. hours)")}
                value={rollup.attr ?? ""}
                onChange={(e) => setRollup({ attr: e.target.value })}
                title={t("Which value to add up, take the highest, or take the lowest")}
              />
            )}
            <TextField
              className="actors-input"
              placeholder={t("Only items tagged #… (optional)")}
              value={rollup.tag ?? ""}
              onChange={(e) => setRollup({ tag: e.target.value })}
              title={t("Only count items that carry this tag")}
            />
          </div>
        );
      })()}
      {/* P2 default value — type-aware input so garbage can't be
          declared by construction (number/date pickers, select from
          the declared options). Empty = no default. Computed (rollup)
          fields have no manual value, so no default. */}
      {!isRollupField(f) && f.type !== "media" && f.type !== "relation" && f.type !== "richtext" && f.type !== "rating" && (
        <div className="schema-field-default">
          <span className="schema-field-default-label" title={t("Set automatically on every newly tagged note (existing values are never overwritten)")}>{t("default")}</span>
          {f.type === "select" ? (
            <Select
              className="actors-input"
              value={f.default ?? ""}
              onChange={(e) => patchField(idx, { default: e.target.value || undefined })}
            >
              <option value="">{t("(none)")}</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : f.type === "boolean" ? (
            <Select
              className="actors-input"
              value={f.default ?? ""}
              onChange={(e) => patchField(idx, { default: e.target.value || undefined })}
            >
              <option value="">{t("(none)")}</option>
              <option value="true">{t("true")}</option>
              <option value="false">{t("false")}</option>
            </Select>
          ) : (
            <TextField
              className="actors-input"
              type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
              placeholder={t("(none)")}
              value={f.default ?? ""}
              onChange={(e) => patchField(idx, { default: f.type === "number" ? numberDefaultFrom(e.target.value) : e.target.value || undefined })}
            />
          )}
        </div>
      )}
      {f.type === "relation" && (
        <TextField
          className="actors-input schema-field-options"
          placeholder={t("restrict to nodes with class tag (optional, e.g. person)")}
          value={f.relation_supertag ?? ""}
          onChange={(e) => patchField(idx, {
            relation_supertag: e.target.value || undefined,
          })}
        />
      )}
    </>
  );
}

export function SchemaEditor({ fields, onChange, fieldUsage, clashes, takenNames = [] }: {
  fields: FieldDef[]; onChange: (next: FieldDef[]) => void;
  /** Fields the host keeps back because another tag has the name (lib/
   *  tagFields.ts draftFieldClashes), keyed by field name: each is marked with
   *  the other tag's name and the field as it shows there. */
  clashes?: ReadonlyMap<string, SchemaFieldClash>;
  /** Names a new field's derived key must avoid (lib/tagFields.ts namesTakenAround). */
  takenNames?: readonly string[];
  /** P2 migration preview: per-field count of notes carrying a value —
   *  shown as a badge, and quoted when removing a used field. `null` means
   *  usage is UNKNOWN (fetch failed / still loading): the badge says so and
   *  destructive actions treat unknown as NOT safe. Omitted (undefined) =
   *  the host doesn't track usage at all; no badge, no gate. */
  fieldUsage?: FieldUsage;
}) {
  const t = useT();
  function patchField(idx: number, patch: Partial<FieldDef>) {
    const next = fields.map((f, i) => i === idx ? { ...f, ...patch } : f);
    onChange(next);
  }
  function addField() {
    // A new `text` field starts unnamed: its key is derived from the label
    // once one is typed (below), and a field still unnamed is not saved
    // (lib/data/tagSchemaWriter.ts).
    onChange([...fields, { name: "", type: "text" }]);
  }
  async function removeField(idx: number) {
    // P2 migration preview (hooks/useFieldUsage): a used field, or one whose
    // usage is unknown, asks first.
    const f = fields[idx];
    if (!f) return;
    if (!(await confirmFieldRemoval(f.label || committedKeyOf(f), committedKeyOf(f), fieldUsage))) return;
    onChange(fields.filter((_, i) => i !== idx));
  }
  function moveField(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= fields.length) return;
    const next = fields.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  }

  return (
    <div className="schema-editor">
      {fields.length === 0 && (
        <EmptyState size="inline" title={t("No fields. Click + to add one.")} />
      )}
      <div className="schema-field-list">
        {fields.map((f, idx) => (
          <div key={idx} className={clashes?.has(committedKeyOf(f)) ? "schema-field-row is-clash" : "schema-field-row"}>
            <FieldEditor f={f} idx={idx} fields={fields} patchField={patchField}
              clashes={clashes} takenNames={takenNames} fieldUsage={fieldUsage} />

            <div className="schema-field-actions">
              <Button
                variant="ghost"
                disabled={idx === 0}
                onClick={() => moveField(idx, -1)}
                aria-label={t("Move up")} title={t("Move up")}
              ><ChevronUp size={12} /></Button>
              <Button
                variant="ghost"
                disabled={idx === fields.length - 1}
                onClick={() => moveField(idx, 1)}
                aria-label={t("Move down")} title={t("Move down")}
              ><ChevronDown size={12} /></Button>
              <Button
                variant="ghost"
                onClick={() => void removeField(idx)}
                aria-label={t("Remove field")} title={t("Remove field")}
              ><Trash2 size={12} /></Button>
            </div>
          </div>
        ))}
      </div>
      <div className="schema-editor-footer">
        <Pressable
          className="schema-add-field-btn"
          onClick={addField}
        >
          <Plus size={12} /> {t("Add field")}
        </Pressable>
      </div>
    </div>
  );
}
