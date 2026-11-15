import { useEffect, useMemo, useState } from "react";
import type { ContentNode } from "../lib/api";
import { drafts, noteActionsFor } from "../lib/data";
import { useAppSelector, useOnline, useTagRows, useTaskRows, useAllNodes } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { t } from "../lib/i18n";
import { pendingItems } from "../lib/aiSuggestions";
import { announceSuggestionsChanged } from "../lib/aiSuggestionsBus";
import { MODULES, importedModules, noteCommandsOf, type AiSuggestionsSummary, type NoteCommand, type NoteFunctionEnv, type NoteFunctionNav, type NoteFunctionRow, type NoteFunctionRowsOf } from "../modules";
import { useAiSuggestions } from "./useAiSuggestions";
import { useAiEnabled, useModuleFilter } from "./useModuleFilter";
import { isNote } from "@onden/markdown/contract";

const NONE: NoteFunctionRow[] = [];

/** A note command with a `row`, as a row of the 「功能」 tab. Its module's name is the small text
 *  over the sentence unless the row names itself. */
function commandRow(command: NoteCommand, moduleId: string, env: NoteFunctionEnv, run: (command: NoteCommand) => void): NoteFunctionRow[] {
  const { row } = command;
  if (!row) return [];
  const related = row.related ? row.related(env.node, env.body) : true;
  const name = row.name ?? MODULES.find((m) => m.id === moduleId)?.library.title ?? "";
  return [{
    id: command.id,
    Icon: row.Icon,
    name: t(name),
    related,
    // A row with no tie yet says what the function would do, not how the note stands.
    status: related ? row.describe(env.node, env.body) : t(row.hint ?? command.label),
    details: related ? row.details?.(env.node, env.body) : undefined,
    action: { label: t(row.action), run: () => run(command) },
  }];
}

/** The rows files of the imported modules, loaded when the panel first needs them (they are not in the
 *  first load). Until a file has come, its module has no rows. */
function useRowProviders(isImported: ReturnType<typeof useModuleFilter>): ReadonlyMap<string, NoteFunctionRowsOf> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, NoteFunctionRowsOf>>(new Map());
  useEffect(() => {
    for (const mod of importedModules(isImported)) {
      if (!mod.noteFunctionRows || loaded.has(mod.id)) continue;
      // The rows' wording comes with them (components/infoFunctions/registerStrings).
      void Promise.all([mod.noteFunctionRows(), import("../components/infoFunctions")]).then(([{ default: rowsOf }]) => setLoaded((prev) => (prev.has(mod.id) ? prev : new Map(prev).set(mod.id, rowsOf))));
    }
  }, [isImported, loaded]);
  return loaded;
}

/** The catalog's rows builder, loaded with the panel's wording the first time an editable note needs it. */
function useCatalogRows(wanted: boolean) {
  const [rows, setRows] = useState<typeof import("../components/functionCatalog").catalogRows | null>(null);
  useEffect(() => {
    if (wanted && !rows) void import("../components/functionCatalog").then((m) => setRows(() => m.catalogRows));
  }, [wanted, rows]);
  return rows;
}

/** Everything the 「功能」 tab lists for the open note: the rows of the imported modules'
 *  `noteFunctionRows` and of their note commands that have a `row`, for a note the person may edit
 *  (a viewer gets the rows that only read). Empty for no note. The body is the open draft when there
 *  is one (read, not subscribed: a keystroke must not re-render the panel; the next save or
 *  selection change refreshes it). */
export function useNoteFunctions(node: ContentNode | null, nav: NoteFunctionNav, run: (command: NoteCommand) => void): NoteFunctionRow[] {
  const isImported = useModuleFilter();
  const online = useOnline();
  const nodes = useAllNodes();
  const edges = useAppSelector((s) => s.data.edges);
  const tasks = useTaskRows();
  const tags = useTagRows();
  const memberships = useAppSelector((s) => s.data.canvas_memberships);
  const caps = useCapabilities(online);
  const canEdit = !!node && caps.canEdit(node);
  const body = node ? drafts.read(node.id)?.markdown ?? node.markdown ?? "" : "";
  const providers = useRowProviders(isImported);
  const catalogOf = useCatalogRows(canEdit);
  const aiOn = useAiEnabled();
  const suggestions = useAiSuggestions({ nodeId: node?.id, markdown: body, canEdit, online: online && aiOn });

  const { view: suggestionsView, decideAll } = suggestions;
  const summary = useMemo<AiSuggestionsSummary | null>(() => {
    const waiting = pendingItems(suggestionsView);
    if (!node || waiting.length === 0) return null;
    const nodeId = node.id;
    return {
      pending: waiting.length,
      items: waiting,
      // Accepting writes the note on the server; the editor's bar and marks read again through the bus.
      acceptAll: async () => { await decideAll("accept"); announceSuggestionsChanged(nodeId, true); },
    };
  }, [node, suggestionsView, decideAll]);

  return useMemo(() => {
    if (!node) return NONE;
    const env: NoteFunctionEnv = {
      node, body, canEdit, online, nodes, edges, tasks, canvasMemberships: memberships ?? [], suggestions: summary, nav,
    };
    const moduleRows = importedModules(isImported).flatMap((m) => providers.get(m.id)?.(env) ?? []);
    const commands = noteCommandsOf(isImported);
    // The commands the person can run on this note now (their `available`), for an editable note.
    const offered = canEdit
      ? noteActionsFor(node, { canEdit, isOwner: caps.isOwner, online, tags, body, commands: commands.map((c) => c.command) }).commands
      : [];
    const commandRows = offered.flatMap(({ command }) => {
      const entry = command && commands.find((c) => c.command === command);
      return entry ? commandRow(command, entry.moduleId, env, run) : [];
    });
    // 「還能用在這則」 also lists the function catalog's functions the note lacks
    // (components/functionCatalog/catalogRows, loaded on use); a
    // module that already has a row above is not listed twice.
    const withRows = new Set([
      ...importedModules(isImported).filter((m) => providers.get(m.id)?.(env).length).map((m) => m.id),
      ...offered.flatMap(({ command }) => commands.find((c) => c.command === command)?.moduleId ?? []),
    ]);
    const catalog = canEdit && isNote(node) && catalogOf ? catalogOf(node, tags ?? [], isImported, withRows) : NONE;
    return [...moduleRows, ...commandRows, ...catalog];
  }, [node, body, canEdit, online, nodes, edges, tasks, tags, memberships, summary, nav, run, isImported, caps, providers, catalogOf]);
}
