// Publishing pipeline shared types.
//
// Extracted from the former publish route during the Day 3 backend refactor.
// Reference pattern: joplin-dev/packages/lib/services/* (services hold typed shapes;
// routes import from services, not vice versa).

import type { FrozenQueryBlock } from "@onden/markdown";

/** A published note as the builders read it. `query_blocks`: its query
 *  blocks frozen at publish time (queryBlocks.ts, D113). */
export type NodeRow = { id: string; title: string; slug: string; markdown: string; query_blocks?: FrozenQueryBlock[] };

export interface Manifest {
  /** Owner-authored CSS appended after the generated theme CSS (⑩). */
  custom_css?: string;
  /** Page background tone of the published site; "" = theme default (⑩). */
  site_bg?: string;
  tokens?: {
    accent?: string;
    font?: string;
    width?: string;
    density?: string;
    /** Opt-in to external web fonts (Google Fonts @import + KaTeX CDN glyphs).
     *  Off by default so a published site makes no third-party request that
     *  would leak a visitor's IP ([[product-thesis]] local-first). */
    webfonts?: boolean;
  };
  site?: {
    brand?: string;
    tagline?: string;
    /** Optional brand-logo image URL shown in the nav instead of brand text. */
    logo?: string;
    nav?: Array<{ label: string; nodeId: string }>;
  };
  [key: string]: unknown;
}

// The Octokit commit-files client type is shared with the per-note backup.
export type { CreateOrUpdateFilesClient } from "../../../services/githubBackup.js";
