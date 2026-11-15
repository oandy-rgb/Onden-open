// A view module tag (#表格 #看板 #月曆 #卡片, left over from before saved views were function references, migration 188)
// is still never applied to a note and never merged, until the module tag nodes themselves are removed (function
// references B3). Nothing makes or links these tags any more: a view is a reference of its tag or note.
//
// Rule 6: a view module tag only describes tags. Applying one is refused (ViewModuleTagError, 409 view_module_tag).

import { q } from "../db.js";
import { isViewLayout } from "./viewLayouts.js";
import { tagNodeSql } from "../spine/nodeSql.js";

/** A view module tag was to be applied to a note (rule 6). */
export class ViewModuleTagError extends Error {
  readonly code = "view_module_tag";
  constructor(readonly module: string, readonly tagTitle: string) {
    super(`#${tagTitle} is a view: add it as a tab on a tag's page, not to a note`);
    this.name = "ViewModuleTagError";
  }
}

/** The module a tag is the module tag of (any module, not only a view's), with its title; null for an ordinary tag. */
export async function moduleMarkerOfTag(workspaceId: string, tagId: string): Promise<{ module: string; title: string } | null> {
  const row = (await q<{ module: string | null; title: string }>(
    `SELECT tag_schema->>'module' AS module, title FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${tagNodeSql()}`,
    [workspaceId, tagId],
  )).rows[0];
  return row?.module ? { module: row.module, title: row.title } : null;
}

/** The view module a tag is the module tag of, or null. */
export async function viewModuleOfTag(workspaceId: string, tagId: string): Promise<{ module: string; title: string } | null> {
  const found = await moduleMarkerOfTag(workspaceId, tagId);
  return found && isViewLayout(found.module) ? found : null;
}

/** Throws ViewModuleTagError when `tagId` is a view module tag. */
export async function assertNotViewModuleTag(workspaceId: string, tagId: string): Promise<void> {
  const view = await viewModuleOfTag(workspaceId, tagId);
  if (view) throw new ViewModuleTagError(view.module, view.title);
}
