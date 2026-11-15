// The studio's Puck config: @onden/site's config (the same render components
// as the published site) with the pickers plugged in. Two corrections to what
// P1a assumed about Puck 0.23:
//  - slot `allow` is read from the static `fields` only, so `resolveFields`
//    could not narrow it by depth; it is removed here and the depth rules are
//    enforced on the data instead (designModel.nestingViolation, HomeStudio);
//  - the panel groups 「進階」 (class name + this part's CSS) into one
//    collapsed field.
import type { Config, Field } from "@puckeditor/core";
import { createPuckConfig } from "@onden/site/react";
import { PART_TYPES, PATTERN_TYPES } from "@onden/site";
import { advancedField, blockField, displayField, noteField, tagField, viewField } from "./fields";

export function createStudioConfig(): Config {
  const config = createPuckConfig({ fields: { note: noteField, tag: tagField, view: viewField } }) as Config;
  for (const component of Object.values(config.components)) delete (component as { resolveFields?: unknown }).resolveFields;

  const fieldsOf = (type: string) => (config.components[type]!.fields ?? {}) as Record<string, Field>;
  fieldsOf("note").blockId = blockField;
  fieldsOf("note").display = displayField;
  for (const type of [...PART_TYPES, ...PATTERN_TYPES]) {
    const fields = fieldsOf(type);
    fields.cls = advancedField;
    delete fields.css;
  }
  return config;
}
