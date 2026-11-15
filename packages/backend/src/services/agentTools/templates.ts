// What a token may call, derived from the tool registry (agent permission
// tiers): a token is `read` or `write`.
//
//   read    every tool whose access is "read": look things up, change nothing
//   write   + tagging and editing notes, creating notes, proposing tag packs
//           (held for the owner's review by construction)
//
// The minted token stores the EXPANDED list, so a registry that grows later
// never silently widens an existing token; to take a new tool, set the
// token's access again.
//
// Which spaces a token reaches is not part of this: that follows its agent's
// space membership (spine/spaceAccess.ts).

import type { TokenAccess } from "../../types.js";
import { listTools } from "./registry.js";

export const TOKEN_ACCESS_LEVELS: readonly TokenAccess[] = ["read", "write"];

export function isTokenAccess(v: unknown): v is TokenAccess {
  return typeof v === "string" && (TOKEN_ACCESS_LEVELS as readonly string[]).includes(v);
}

/** The tool names a token of `access` may call, from the live registry. */
export function toolsForAccess(access: TokenAccess): string[] {
  return listTools()
    .filter((tool) => tool.access === "read" || (access === "write" && tool.access === "write"))
    .map((tool) => tool.name);
}
