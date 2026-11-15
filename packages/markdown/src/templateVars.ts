// The placeholders a scaffold may carry, read the same way wherever one is
// stamped: the app's note templates (lib/noteTemplates.ts) and a tag's
// template children on the server (services/templateExpander.ts). Before this
// only the app expanded them, so `{date}` in a tag pack's child titles stayed
// literal (D69).
//
// The caller supplies the values (each side knows the workspace's day in its
// own way: lib/localDate.ts in the app, localDay.ts on the server); this only
// substitutes, so both ends agree on the names and nothing else.

/** The values a template's placeholders take. */
export type TemplateVars = {
  /** `{date}`: today, YYYY-MM-DD, in the workspace's zone. */
  date: string;
  /** `{datetime}`: now, YYYY-MM-DD HH:MM, in the workspace's zone. */
  datetime: string;
};

/** Substitute `{date}` and `{datetime}`; anything else in braces is kept as
 *  written. */
export function applyTemplateVars(text: string, vars: TemplateVars): string {
  return text.replace(/\{(date|datetime)\}/g, (_, name: keyof TemplateVars) => vars[name]);
}
