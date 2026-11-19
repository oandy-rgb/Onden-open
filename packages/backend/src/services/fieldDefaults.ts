// P2 tag-schema upgrade: field DEFAULTS — applying a schema tag seeds its
// fields' declared defaults as 'derived' attributes (never overwriting
// anything the user already set). Runs in the tag-apply cascade, so every
// seeded ATTRIBUTE_SET points triggered_by at the TAG_APPLIED root and the
// inbox/cascade-preview see it like any other cascade child.

import { q } from "../db.js";
import { runCascade } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import type { StoredFieldDef } from "./schemaValidation.js";
import { effectiveFieldsOf } from "./tagFields.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { recordAttributeChange } from "./attributeChange.js";

export async function applyFieldDefaults(
  workspaceId: string,
  nodeId: string,
  tagId: string,
  actor: ActorCtx,
  causeEventId?: string,
): Promise<void> {
  // P4.1 (mig 073): fields live on the class_tag node's tag_schema shadow now —
  // no collection_schemas JOIN. A label tag with no schema has NULL tag_schema →
  // NULL fields → the `?? []` below seeds nothing.
  // q(), not pool: a tag created earlier in this transaction must be visible.
  // The tag's effective fields: its own and those it inherits (tagFields.ts),
  // so an inherited field's default is seeded too.
  const withDefaults = (await effectiveFieldsOf(workspaceId, tagId)).filter(
    (f): f is StoredFieldDef & { default: string } => typeof f?.default === "string" && f.default !== "" && !!f.name,
  );
  if (withDefaults.length === 0) return;

  const existing = await q<{ key: string }>(
    `SELECT key FROM node_attributes WHERE node_id = $1 AND key = ANY($2::text[])`,
    [nodeId, withDefaults.map((f) => f.name)],
  );
  const taken = new Set(existing.rows.map((r) => r.key));
  const toSeed = withDefaults.filter((f) => !taken.has(f.name)); // user-set values always win
  if (toSeed.length === 0) return;

  // Seeding is a derived effect of the tag application the route already
  // authorized ({tag, apply}); it only writes the tag's declared (own or inherited) fields and
  // never overwrites a user value (ON CONFLICT DO NOTHING). It carried no node
  // write-check historically — adding one here would risk mis-denying a
  // legitimate apply (plan §P3.2 difficulty #3), so the cascade is rooted with
  // an auditable `open`, not a re-asserted {node, write_node}. runCascade opens
  // the store so each seeded ATTRIBUTE_SET rides the spine as a cascade child of
  // the TAG_APPLIED root (triggered_by = causeEventId).
  await runCascade(
    { actor, workspaceId, authority: { kind: "open", why: "schema-default seeding rides the route-authorized tag apply" }, causeEventId },
    async () => {
      await withEventTransaction(workspaceId, async () => {
        for (const field of toSeed) {
          // Only when the key is absent (a concurrent seed or explicit edit
          // keeps its value), recorded from the row actually written so the
          // TAG_APPLIED / TAG_MERGED cascade restore can remove the seed.
          await recordAttributeChange({
            workspaceId, nodeId, key: field.name, actor,
            // The tag is applied, so the write stores the field's own type.
            next: { value: field.default!, source: "derived" },
            rule: "absent", inheritedAtCreation: true,
            authority: { kind: "cascade" },
            uiContext: "tag.field_default",
            payload: { tag_id: tagId },
          });
        }
      });
    },
  );
}
