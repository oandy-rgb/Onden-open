import { api, type Bootstrap, type SiteConfig, type Tag, type Workspace } from "../api";
import { upsertWorkspace } from "../localDb";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle, reconcileFields } from "./writeLifecycle";
import type { DataCtx } from "./types";
import { makeOnlineOperation } from "./onlineWrite";
import { t } from "../i18n";

export function makeWorkspaceWriter(ctx: DataCtx) {
  const submit = makeWriteLifecycle(ctx);
  const operation = makeOnlineOperation(ctx);
  const mirror = () => upsertWorkspace(ctx.data.workspace, { site_config: ctx.data.site_config, chrome: ctx.data.chrome });

  async function setHome(id: string | null) {
    const resource = `workspace:${ctx.data.workspace.id}`;
    const settle = optimisticFields<Workspace>(resource, ctx.data.workspace, { home_node_id: id });
    ctx.setData((state) => ({ ...state, workspace: { ...state.workspace, home_node_id: id } }));
    const finish = (accepted: boolean, server: Partial<Workspace> = {}) => {
      const { expected, replacement } = settle(accepted, server);
      ctx.setData((state) => ({ ...state, workspace: reconcileFields(state.workspace, expected, replacement) }));
    };
    return submit<Workspace>(resource, { method: "PATCH", path: "/api/workspace", body: JSON.stringify({ home_node_id: id }) }, {
      mirror, accepted: (result) => finish(true, result.status === "synced" ? result.value : {}),
      rejected: () => finish(false), unconfirmed: () => { settle(true); },
    });
  }

  /** Save site settings and/or the chrome. `chromeBase`: the chrome revision
   *  the new chrome started from; the server refuses a stale one (409
   *  design_stale, D119), and the change is rolled back here. */
  async function saveDesign(input: { config?: SiteConfig; chrome?: Bootstrap["chrome"]; chromeBase?: string | null }, options: { keepalive?: boolean } = {}) {
    const resource = `workspace:${ctx.data.workspace.id}`;
    // Config PATCH is a merge. Journal individual keys so one failed setting
    // cannot undo a later edit to another setting (or the separate layout).
    const configSettle = optimisticFields<SiteConfig>(`${resource}:config`, ctx.data.site_config ?? {}, input.config ?? {});
    const chromeSettle = optimisticFields<Bootstrap>(resource, ctx.data, input.chrome === undefined ? {} : { chrome: input.chrome });
    ctx.setData((state) => ({ ...state,
      site_config: { ...state.site_config, ...input.config },
      ...(input.chrome === undefined ? {} : { chrome: input.chrome }),
    }));
    const finish = (accepted: boolean, server?: { config?: SiteConfig; chrome?: Bootstrap["chrome"] }) => {
      const config = configSettle(accepted, server?.config);
      const chrome = chromeSettle(accepted, server?.chrome === undefined ? {} : { chrome: server.chrome });
      ctx.setData((state) => ({ ...reconcileFields(state, chrome.expected, chrome.replacement),
        site_config: reconcileFields(state.site_config ?? {}, config.expected, config.replacement),
      }));
    };
    return submit<{ config: SiteConfig; chrome: Bootstrap["chrome"] }>(resource, {
      method: "PATCH", path: "/api/workspace/config", init: options,
      body: JSON.stringify({ config: input.config, chrome: input.chrome, ...(input.chromeBase === undefined ? {} : { chrome_base: input.chromeBase }) }),
    }, {
      mirror, accepted: (result) => finish(true, result.status === "synced" ? result.value : undefined),
      rejected: () => finish(false), unconfirmed: () => { configSettle(true); chromeSettle(true); },
    });
  }

  /** Replace this device's chrome with the server's (after a design_stale
   *  refusal: another tab or device saved a newer design). Online only;
   *  throws when the server cannot be reached. */
  async function reloadDesign(): Promise<Bootstrap["chrome"]> {
    const current = await api<{ chrome: Bootstrap["chrome"] }>("/api/workspace/config");
    const chrome = current.chrome ?? null;
    ctx.setData((state) => ({ ...state, chrome }));
    try { await mirror(); } catch { /* the next bootstrap/sync repairs the mirror */ }
    return chrome;
  }

  /** Turn a module on or off (module library). An online decision like tag
   *  functions: nothing changes on this device until the server accepts it,
   *  then the store and the local mirror take the server's list. Turning on a
   *  module with a module tag also makes sure the tag exists (`tagName`, in
   *  the interface language); until the catalog syncs, the store holds a
   *  provisional row for it so the library and tag pages show it at once. */
  async function setModuleImported(module: string, imported: boolean, online: boolean, tagName?: string): Promise<{ modules: string[]; moduleTagId: string | null }> {
    // The one online operation: a retry of the same decision reuses its key
    // (a new key per call used to make a retry after a lost reply unsafe), and
    // a failure is reported there.
    const body = JSON.stringify({ module, imported, ...(tagName ? { tag_name: tagName } : {}) });
    const reply = await operation(`workspace:${ctx.data.workspace.id}:modules`, t("Connect to change modules."),
      (send) => send<{ modules: string[]; modules_to_confirm?: string[]; module_tag_id?: string }>("/api/workspace/modules", body, "PATCH"), online);
    // A replayed decision carries no body; it already applied, so the list is
    // ours with this module in or out (its module tag arrives with the sync).
    const current = ctx.data.workspace.modules ?? [];
    const pending = ctx.data.workspace.modules_to_confirm ?? [];
    const result = "deduped" in reply
      ? { modules: imported ? [...new Set([...current, module])] : current.filter((id) => id !== module),
          modules_to_confirm: imported ? pending.filter((id) => id !== module) : pending }
      : reply;
    const moduleTagId = result.module_tag_id ?? null;
    ctx.setData((state) => {
      const tags = state.tags ?? [];
      const known = moduleTagId === null || tags.some((tag) => tag.id === moduleTagId);
      const provisional: Tag | null = known ? null : {
        id: moduleTagId!, name: tagName || module, color: "", schema_id: moduleTagId,
        schema_fields: [], schema_behaviour: {}, schema_module: module, schema_extends: [], effective_modules: [module],
      };
      return { ...state, workspace: { ...state.workspace, modules: result.modules, modules_to_confirm: result.modules_to_confirm ?? state.workspace.modules_to_confirm },
        ...(provisional ? { tags: [...tags, provisional] } : {}) };
    });
    try { await mirror(); } catch { /* the next bootstrap/sync repairs the mirror */ }
    return { modules: result.modules, moduleTagId };
  }

  /** Choose the space RSS subscriptions live in (Settings › Modules › RSS,
   *  訂閱放在; "" = each person's own space). An online decision like the
   *  module list: the server writes the setting and moves the owner's
   *  subscriptions in one transaction, and only then does this device show the
   *  new value. Answers how many subscriptions moved (0 for a replayed answer). */
  async function setRssSourceSpace(spaceId: string, online: boolean): Promise<{ moved: number; skippedDuplicate: number }> {
    const reply = await operation(`workspace:${ctx.data.workspace.id}:rss-source-space`, t("Connect to change where subscriptions live."),
      (send) => send<{ space_id: string; moved: number; skipped_duplicate: number }>("/api/rss/source-space", JSON.stringify({ space_id: spaceId }), "PUT"), online);
    ctx.setData((state) => {
      const { rss_source_space: _previous, ...rest } = (state.site_config ?? {}) as SiteConfig;
      return { ...state, site_config: spaceId ? { ...rest, rss_source_space: spaceId } : rest };
    });
    try { await mirror(); } catch { /* the next bootstrap/sync repairs the mirror */ }
    return "deduped" in reply ? { moved: 0, skippedDuplicate: 0 } : { moved: reply.moved, skippedDuplicate: reply.skipped_duplicate ?? 0 };
  }

  /** Set the zone the workspace's days are cut in and/or the hour a day starts
   *  at (owner only; Settings › Time). `timeZone: null` goes back to the server
   *  default. An online decision like the module list: nothing changes on this
   *  device until the server accepts it, then the store and the local mirror take
   *  what it holds. Other devices get it through the sync delta. Answers what
   *  the setting was before, for 「改回」. */
  async function setTime(change: { timeZone?: string | null; dayStartHour?: number }, online: boolean): Promise<{ previous: { timeZone: string | null; dayStartHour: number } }> {
    const previous = { timeZone: ctx.data.workspace.time_zone ?? null, dayStartHour: ctx.data.workspace.day_start_hour ?? 0 };
    const body = JSON.stringify({
      ...(change.timeZone === undefined ? {} : { time_zone: change.timeZone }),
      ...(change.dayStartHour === undefined ? {} : { day_start_hour: change.dayStartHour }),
    });
    const reply = await operation(`workspace:${ctx.data.workspace.id}:time`, t("Connect to change the time settings."),
      (send) => send<{ time_zone: string | null; day_start_hour: number }>("/api/workspace/time", body, "PATCH"), online);
    // A replayed decision carries no body; it already applied as asked.
    const next = "deduped" in reply
      ? { time_zone: change.timeZone === undefined ? previous.timeZone : change.timeZone, day_start_hour: change.dayStartHour ?? previous.dayStartHour }
      : reply;
    ctx.setData((state) => ({ ...state, workspace: { ...state.workspace, time_zone: next.time_zone, day_start_hour: next.day_start_hour } }));
    try { await mirror(); } catch { /* the next bootstrap/sync repairs the mirror */ }
    return { previous };
  }

  return { setHome, saveDesign, reloadDesign, setModuleImported, setRssSourceSpace, setTime };
}
