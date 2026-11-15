// Display names for the built-in columns a view can list (the ids are what
// the view stores). Any other field is the user's own: its name is its label.
const BUILT_IN_FIELD_LABELS: Record<string, string> = {
  title: "Title", slug: "Slug", updated_at: "Updated at", created_at: "Created at", sort_order: "Manual order",
};

/** The text a column header or card badge shows for `field`. `t` is the
 *  caller's translate function. */
export function fieldDisplayName(field: string, t: (source: string) => string): string {
  const source = BUILT_IN_FIELD_LABELS[field];
  return source ? t(source) : field;
}
