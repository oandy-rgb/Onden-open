// @onden/site/react — the Puck config and the server-renderable components of
// the home page. Frontend only (bundled from source). The part CSS is
// "@onden/site/react/siteParts.css".
export { createPuckConfig, type CreatePuckConfigOptions } from "./config.js";
export type { SiteNote, SiteRenderMeta } from "./meta.js";
export { COMPONENT_LABELS, CATEGORY_LABELS, FIELD_LABELS, OPTION_LABELS } from "./labels.js";
export { RowsView, firstParagraph } from "./render.js";
