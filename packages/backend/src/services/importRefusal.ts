import { AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";

/** Import's one rule for what may be skipped and counted rather than stop the
 *  request: a permission or scope refusal, or a unique-name collision. Storage
 *  failures and unknown errors are rethrown — an import must not report
 *  "skipped" for data it failed to write. (importMarkdown applies the same
 *  rule to notes.) */
export function isImportRefusal(error: unknown): boolean {
  return error instanceof AuthorityError
    || error instanceof ScopeError
    || (error as { code?: string } | null)?.code === "23505";
}
