// The site configuration (brand, accent, navigation) as the bootstrap, GET /api/site and the sync delta send it.
// Pure types: the app imports them with `import type`, so nothing here may run.

export type SiteConfig = {
  brand?: string;
  tagline?: string;
  accent?: string;
  font?: string;
  darkMode?: boolean;
  home_node_id?: string;
  // nav is stored as a serialized JSON string in node_attributes, but the
  // /api/site overlay path parses it back into an array. Callers must handle
  // both shapes (siteSettingsFromConfig).
  nav?: string | Array<{ label: string; nodeId: string }>;
  [k: string]: unknown;
};
