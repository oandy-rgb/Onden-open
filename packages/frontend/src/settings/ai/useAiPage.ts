import { useCallback, useEffect, useRef, useState } from "react";

import { reads } from "../../lib/data";
import { onAppResume } from "../../lib/appResume";
import { isPageHidden } from "../../lib/documentAccess";
import type { AiRoleInfo } from "./aiRoleInfo";
import type { AiPageData, CodeConnection, KeyConnection } from "./model";

/** How often the open page asks again. Half of the "connected lately" window, so a come-and-go shows within it. */
export const REFRESH_MS = 30_000;

type CredentialRow = { id: string; label: string; last4: string; created_at: string; revoked_at: string | null; base_url: string };
type TokenRow = { id: string; name: string; access: "read" | "write"; last_used_at: string | null; revoked_at: string | null };

/** Everything 設定 › AI draws, read together: the keys, the AIs, and each AI's connection codes.
 *  `reload` reads it all again after any change; the previous picture stays on screen meanwhile. */
export function useAiPage(online: boolean): { data: AiPageData | null; failed: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<AiPageData | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const { api_runtime_offered: offered } = await reads.aiRuntime.status();
      const [credentials, roles] = await Promise.all([
        offered ? reads.aiRuntime.credentials<CredentialRow>().then((r) => r.credentials) : Promise.resolve<CredentialRow[]>([]),
        reads.aiRuntime.roles<AiRoleInfo>().then((r) => r.roles),
      ]);
      const tokens = await Promise.all(roles.map(async (role) =>
        (await reads.people.actorTokens<TokenRow>(role.actor_id).catch(() => [] as TokenRow[]))
          .filter((k) => !k.revoked_at)
          .map((k): CodeConnection => ({ kind: "code", id: k.id, actorId: role.actor_id, name: k.name, lastUsedAt: k.last_used_at, access: k.access }))));
      if (mine !== latest.current) return;
      const keys = credentials.filter((c) => !c.revoked_at).map((c): KeyConnection => ({
        kind: "key", id: c.id, label: c.label, last4: c.last4, baseUrl: c.base_url, createdAt: c.created_at,
      }));
      setData({ offered, keys, codes: tokens.flat(), roles });
      setFailed(false);
    } catch { if (mine === latest.current) setFailed(true); }
  }, []);

  useEffect(() => { if (online) void reload(); }, [online, reload]);
  // "Connected" comes from when the person's software last came, which changes without anything on this page
  // changing (and without a sync event). Read again on a timer while the page is on screen, and when the person
  // returns to the tab, so a page left open does not keep saying "nothing has connected".
  useEffect(() => {
    if (!online) return;
    const refresh = () => { if (!isPageHidden()) void reload(); };
    const timer = setInterval(refresh, REFRESH_MS);
    const offResume = onAppResume(refresh, ["visible", "focus", "online"]);
    return () => { clearInterval(timer); offResume(); };
  }, [online, reload]);
  return { data, failed, reload };
}
