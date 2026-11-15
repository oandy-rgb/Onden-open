// What the owner's settings know about one AI role (GET /api/ai/roles): how its edits
// take effect, which ways of running work right now and why not, this month's use.
// The server computes every "available" from facts; this file only words them.
import { useCallback, useEffect, useState } from "react";

import type { AiRoleApiSettings } from "@onden/contract";
import { reads } from "../../lib/data";

export type { RuntimeKind, RuntimeEntry } from "../../lib/aiRuntimeText";
import type { RuntimeKind, RuntimeEntry } from "../../lib/aiRuntimeText";
export type ReviewRule = "suggest" | "apply";
/** The API way of running: key (id, label and last four only), model, limits, spend so far. */
export type ApiSettings = AiRoleApiSettings;
export type AiRoleInfo = {
  actor_id: string; handle: string; name: string; enabled: boolean; default_runtime: RuntimeKind;
  runtimes: RuntimeEntry[];
  review_rule: ReviewRule; review_rule_locked: boolean;
  /** Where it stands in each shared space it is in; a space it is not in is absent. */
  spaces: Record<string, "view" | "edit">;
  usage_this_month: { input_tokens: number; output_tokens: number; cost_estimate_micro_usd: number | null };
  runner_seen_at: string | null;
  api: ApiSettings | null;
};

/** One role's info, loaded again whenever `refreshKey` changes. Null while loading or when the read fails. */
export function useAiRoleInfo(actorId: string, refreshKey: number) {
  const [role, setRole] = useState<AiRoleInfo | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    reads.aiRuntime.roles<AiRoleInfo>()
      .then((r) => { if (!cancelled) setRole(r.roles.find((x) => x.actor_id === actorId) ?? null); })
      .catch(() => { if (!cancelled) setRole(null); });
    return () => { cancelled = true; };
  }, [actorId, refreshKey, version]);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  return { role, reload };
}

export { useRuntimeText } from "../../lib/aiRuntimeText";
