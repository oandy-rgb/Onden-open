// Reserved workspace-configuration nodes.
//
// Site settings (brand, tagline, theme, nav, custom CSS, …) live as attributes
// on a hidden "Site Config" content node tagged with the reserved
// `workspace-config` class_tag (see siteConfig.ts). Those two rows ARE the
// workspace settings, so changing or deleting them must need the same
// authority as PATCH /api/workspace/config (workspace admin). Without this a
// self-signup viewer could DELETE them through the ordinary node routes —
// untagged nodes have no policy, so "no policy = allowed" let it through — and
// the settings were recreated empty (GAP-260).
//
// This module owns the question "is this node workspace configuration?" so the
// authority layer can answer it once for every entry point (REST, agent tools,
// restore, import) instead of each route special-casing it.

import { q } from "../db.js";
import { RESERVED_TAGS, reservedTagPredicate } from "./reservedTagKeys.js";
import { notTagNodeSql } from "./nodeSql.js";

export const CONFIG_TAG_NAME = RESERVED_TAGS.config;

/** The config tag, live or trashed, by its key only (reservedTagPredicate):
 *  a guard must also cover restoring or purging it. A tag merely TITLED
 *  workspace-config — a member's #foo/workspace-config, or a root one with no
 *  key — is an ordinary tag. */
const CONFIG_TAG_SQL = (alias: string) => reservedTagPredicate(alias, RESERVED_TAGS.config, { lifecycle: "any" });

/** List hygiene for every query surface (/api/query, saved views, search,
 *  the AI scopes and notes tools via harness/scope.aiReadable): system
 *  machinery is never a result row, and never material sent to a model.
 *  Backend twin of the frontend's lib/systemNodes.isSystemNode, which Bases (basesEval.applyView) applies —
 *  source_type='system' rows and the workspace-config tag itself (by its key,
 *  whatever it is titled). The shared fixture
 *  frontend/src/test/fixtures/tagMembershipParity.json checks both ends.
 *  Parameter-free, so it drops into any WHERE. */
export const NOT_SYSTEM_NODE_SQL = (alias: string) =>
  // COALESCE: a key-less tag makes the key comparison NULL, and NOT NULL
  // would drop every ordinary tag row.
  `(${alias}.source_type <> 'system' AND NOT COALESCE(${CONFIG_TAG_SQL(alias)}, false))`;

/** A row /api/query and saved views may return: not system machinery and not
 *  a tag DEFINITION (node_type='class_tag'). Results are notes and boards;
 *  tags are listed by the tag catalog. Before T5 the keyless-tag NULL in the
 *  config check hid every ordinary tag row by accident (and let keyed
 *  #task/#page rows through); this states the rule. */
export const LISTED_NODE_SQL = (alias: string) =>
  `(${notTagNodeSql(alias)} AND ${NOT_SYSTEM_NODE_SQL(alias)})`;

/** True when `nodeId` is the workspace-config class_tag or a node carrying it.
 *  Lifecycle-agnostic on purpose: restoring or purging a deleted config node is
 *  as sensitive as editing a live one. */
export async function isWorkspaceConfigNode(nodeId: string): Promise<boolean> {
  const r = await q(
    `SELECT 1
       FROM content_nodes n
      WHERE n.id = $1
        AND (
          ${CONFIG_TAG_SQL("n")}
          OR EXISTS (
            SELECT 1 FROM node_tags nt
              JOIN content_nodes t ON t.id = nt.tag_id
             WHERE nt.node_id = n.id AND ${CONFIG_TAG_SQL("t")}
          )
        )
      LIMIT 1`,
    [nodeId],
  );
  return r.rows.length > 0;
}

/** True when `tagId` is the reserved workspace-config class_tag. Applying it to
 *  another node, or removing it from Site Config, would change which node
 *  holds the settings. */
export async function isWorkspaceConfigTag(tagId: string): Promise<boolean> {
  const r = await q(
    `SELECT 1 FROM content_nodes c WHERE c.id = $1 AND ${CONFIG_TAG_SQL("c")} LIMIT 1`,
    [tagId],
  );
  return r.rows.length > 0;
}
