const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const HEX_COLOR_ANY = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Is `value` a `#rrggbb` colour (either case)? The one definition for
 *  "a colour a client may store": note colours, tag colours, edge colours,
 *  site design colours. Short (`#fff`) and alpha forms are not accepted;
 *  `normalizeHexColor` reads those when stored data may have them. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** A stored colour written `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as `#rrggbb` / `#rrggbbaa`
 *  in lower case, or null for anything else. For data that was saved before the
 *  picker only wrote `#rrggbb` (the site's page background). */
export function normalizeHexColor(value: string): string | null {
  const text = value.trim();
  if (!HEX_COLOR_ANY.test(text)) return null;
  const digits = text.slice(1).toLowerCase();
  return "#" + (digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits);
}
