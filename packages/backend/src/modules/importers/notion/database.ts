// Orchestrates a deep Notion/CSV database import: a CSV table → a tag with a
// typed schema (+ a table view + a kanban grouped on a select column) + one
// note per row, with each row's Notion page body (`<Title> <hash>.md`)
// attached as the note's markdown.
//
// This is the actuation half of the import; the PURE schema/row derivation
// lives in csvDatabaseImport.ts so it can be unit-tested without a database.
// Rows are created through createNote (createImportedRow), so they land as
// tagged content_nodes with node_attributes — the same substrate the table
// view already renders — with NO parallel write path.

import { recordVersion } from "../../../spine/noteVersions.js";
import { q } from "../../../db.js";
import { mutate } from "../../../spine/mutate.js";
import { putBlob } from "../../../services/blobs.js";
import { applyBodyChange } from "../../../services/bodySideEffects.js";
import { makeInversePatch } from "../../../services/eventLog/index.js";
import { createNote } from "../../../services/noteCreate.js";
import { assertAuthority } from "../../../spine/authority.js";
import { recordAttributeChange } from "../../../services/attributeChange.js";
import { PERSON_SOURCE } from "../../../spine/attributeSource.js";
import { attachTagInTx } from "../../../services/tagMembershipWrites.js";
import { buildTagSchema, insertTagRow } from "../../../services/tagWrites.js";
import {
  parseCsv,
  type CsvTable,
} from "../csv/import.js";
import {
  inferSchemaFields,
  toCollectionField,
  defaultViews,
  rowToItem,
  parseNotionId,
  cleanNotionTitle,
  dedupNotionCsvFiles,
  collectionNameFromCsvPath,
  type InferredField,
} from "../csv/database.js";
import type { ActorCtx } from "../../../types.js";
import { isImportRefusal } from "../../../services/importRefusal.js";
import { appendTagView, type ViewCreate } from "../../../services/tagViews.js";
import { ModuleNotImportedError } from "../../../services/workspaceModules.js";
import { withEventTransaction } from "../../../spine/eventTransaction.js";
import { clampNoteTitle, noteSizeProblem, normalizeText, serializeValue, slugify, storageType } from "@onden/markdown";

export type CsvFile = { path: string; content: string };
export type MdFile = { path: string; content: string };

export type NotionDbImportResult = {
  /** Number of database tags created (one per CSV database). */
  collections: number;
  /** CSV files whose database was not made (a refused schema: permission, or a tag of that name already there). */
  databasesSkipped: string[];
  /** Number of rows turned into notes. */
  rows: number;
  /** Rows skipped (bad data, or dedup'd by Notion page id). */
  rowsSkipped: number;
  /** Row page bodies that were attached to a row's note. */
  bodiesAttached: number;
  /** Row page bodies over the note cap (services/noteSize.ts): the row is
   *  imported without its body, which is never cut. */
  bodiesSkipped: Array<{ path: string; reason: "too_large" }>;
  /** Rows whose title cell was cut to the note title cap for the note's
   *  title (importedRowTitle); the cell keeps the full text. */
  titlesTruncated: Array<{ path: string; row: number }>;
  /** Date columns kept as text because their day/month order is unknowable. */
  ambiguousDateColumns: Array<{ path: string; column: string }>;
  /**
   * Set of md file *paths* consumed as row page-bodies. The route excludes
   * these from the loose-note import so a Notion page doesn't land twice (once
   * as a note, once as a row).
   */
  consumedMdPaths: Set<string>;
};

/**
 * Build a lookup from a Notion page id (or a folder + normalized title) to the
 * md page body that belongs to it. Notion names a row's page file
 * `<Title> <hash>.md`, so we key first by the trailing hash and fall back to
 * the cleaned title WITHIN the database's own folder: a title alone is not
 * unique across a whole export. Several files under one key stay a list so the
 * caller can refuse to guess.
 */
function indexPageBodies(mdFiles: MdFile[]): {
  byId: Map<string, MdFile>;
  byFolderTitle: Map<string, MdFile[]>;
} {
  const byId = new Map<string, MdFile>();
  const byFolderTitle = new Map<string, MdFile[]>();
  for (const f of mdFiles) {
    const base = f.path.split("/").pop() ?? f.path;
    const name = base.replace(/\.md$/i, "");
    const id = parseNotionId(name);
    if (id) byId.set(id, f);
    const key = folderTitleKey(dirOf(f.path), name);
    byFolderTitle.set(key, [...(byFolderTitle.get(key) ?? []), f]);
  }
  return { byId, byFolderTitle };
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function folderTitleKey(folder: string, title: string): string {
  return `${normalizeText(folder).toLowerCase()}\u0000${titleKey(title)}`;
}

/** The folder Notion puts a database's row pages in: next to the CSV, named
 *  like it (with or without the page-id hash). Pages elsewhere are not rows. */
function rowFolders(csvPath: string, mdFiles: MdFile[]): Set<string> {
  const parent = dirOf(csvPath);
  const name = collectionNameFromCsvPath(csvPath).toLowerCase();
  const folders = new Set<string>();
  for (const f of mdFiles) {
    const dir = dirOf(f.path);
    const at = dir.lastIndexOf("/");
    const head = at < 0 ? "" : dir.slice(0, at);
    const last = at < 0 ? dir : dir.slice(at + 1);
    if (last && head === parent && cleanNotionTitle(last).toLowerCase() === name) folders.add(dir);
  }
  return folders;
}

/** A page title as indexPageBodies keys it: cleaned, NFC (a macOS zip names
 *  its files decomposed, the CSV spells the title composed — D58) and
 *  lower-cased. */
function titleKey(title: string): string {
  return normalizeText(cleanNotionTitle(title)).toLowerCase();
}

/** Strip a Notion page's leading "# Title" + property table preamble so the
 *  attached body is just the prose. Conservative: only removes a leading H1
 *  that duplicates the title. */
function cleanPageBody(content: string, title: string): string {
  const lines = content.split("\n");
  if (lines.length > 0) {
    const first = normalizeText(lines[0]!.trim());
    const cleanTitle = normalizeText(cleanNotionTitle(title).trim());
    if (first === `# ${cleanTitle}` || first === `# ${normalizeText(title.trim())}`) {
      lines.shift();
      while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
    }
  }
  return lines.join("\n");
}

/** A row's note title: its title cell, cut to the note title cap (the full
 *  cell stays in its attribute). */
function importedRowTitle(cell: unknown): string {
  if (typeof cell === "string" && cell.trim()) return clampNoteTitle(cell.trim());
  if (typeof cell === "number") return String(cell);
  return "Untitled";
}

/** One imported row as a note tagged with the database's tag, its cells as
 *  attributes. Node, cells, membership and their events are one creation
 *  operation (createNote): a failed event cannot leave a half-made row. */
export async function createImportedRow(
  workspaceId: string,
  tagId: string,
  row: {
    title: string; data: Record<string, unknown>;
    fieldTypes: ReadonlyArray<{ name: string; type: string }>; actor: ActorCtx;
  },
): Promise<{ id: string }> {
  const types = new Map(row.fieldTypes.map((f) => [f.name, f.type]));
  const { node } = await createNote({
    actor: row.actor, workspaceId, title: row.title,
    event: { uiContext: "import.notion.row", payload: { schema_id: tagId } },
    within: async ({ nodeId, eventId, current }) => {
      // Importing a row IS applying the tag: held to the same tag-apply policy
      // as tagMembershipWrites, for the current actor.
      await assertAuthority(current, { kind: "tag_membership", nodeId, tagId, op: "apply" });
      for (const [key, value] of Object.entries(row.data)) {
        const type = types.get(key);
        if (!type || value == null || value === "") continue;
        // The tag is attached below, so its field is not yet found by the
        // write: the field's storage type goes along as the hint.
        await recordAttributeChange({
          workspaceId, nodeId, key, actor: row.actor, rule: "always",
          authority: { kind: "cascade" }, uiContext: "import.notion.row",
          next: { value: serializeValue(value), value_type: storageType(type as Parameters<typeof storageType>[0]), source: PERSON_SOURCE },
        });
      }
      // After the explicit cells, so defaults only fill what was left empty.
      await attachTagInTx({ workspaceId, nodeId, tagId, actor: row.actor, causeEventId: eventId });
    },
  });
  return { id: node.id as string };
}

/**
 * Import every CSV database in `csvFiles` as a tag with its rows. `mdFiles` is the full
 * set of markdown files in the export so per-row page bodies can be matched and
 * attached (and reported back so they aren't re-imported as loose notes).
 */
export async function importNotionDatabases(
  workspaceId: string,
  csvFiles: CsvFile[],
  mdFiles: MdFile[],
  actor: ActorCtx,
  /** Rewrites a body with its original source path, so relative attachments
   * remain relative to the row page, not its database CSV. */
  rewriteBody: (body: string, sourcePath: string) => string = (b) => b,
): Promise<NotionDbImportResult> {
  const result: NotionDbImportResult = {
    collections: 0,
    databasesSkipped: [],
    rows: 0,
    rowsSkipped: 0,
    bodiesAttached: 0,
    bodiesSkipped: [],
    titlesTruncated: [],
    ambiguousDateColumns: [],
    consumedMdPaths: new Set<string>(),
  };

  // Notion exports each database twice (`<DB>.csv` + `<DB>_all.csv`); keep the
  // complete one so we don't import the database twice.
  const keepPaths = new Set(dedupNotionCsvFiles(csvFiles.map((f) => f.path)));
  const tables: Array<{ file: CsvFile; table: CsvTable; fields: InferredField[] }> = [];
  for (const file of csvFiles) {
    if (!keepPaths.has(file.path)) continue;
    const table = parseCsv(file.content);
    if (!table || table.rows.length === 0 || table.header.length === 0) continue;
    tables.push({ file, table, fields: inferSchemaFields(table) });
  }
  if (tables.length === 0) return result;

  const { byId, byFolderTitle } = indexPageBodies(mdFiles);
  // A file is attached to one row only, and only once it was attached for real.
  const usedBodies = new Set<string>();

  for (const { file, table, fields } of tables) {
    if (fields.length === 0) continue;
    const name = collectionNameFromCsvPath(file.path) || "Imported";

    // 1) Create the database's tag (typed fields + view mappings).
    let schemaId: string;
    const collectionFields = fields.map(toCollectionField);
    const views = buildSchemaViews(fields);
    const titleField = defaultViews(fields).title_field;
    const slug = slugify(name, "collection");
    try {
      const schema = await mutate<{ id: string }>({
        actor,
        workspaceId,
        authority: { kind: "any_space_write" },
        timing: "after",
        event: {
          type: "COLLECTION_SCHEMA_CREATED",
          targetType: "tag",
          targetId: (r) => r.id,
          payload: { name, slug },
          txMeta: { ui_context: "import.notion.schema" },
        },
        apply: async () => {
          // The database IS a class_tag node carrying the schema. The columns
          // keep their names ("Due Date"): the rows' values are stored under
          // exactly those keys (tagWrites FieldNameRule).
          const { id } = await insertTagRow(workspaceId, {
            title: slug, color: null,
            schema: buildTagSchema({ name, slug, fields: collectionFields, views }),
            fieldNames: "import",
          });
          return { id };
        },
      });
      schemaId = schema.id; // the class_tag node id
    } catch (error) {
      // A refused schema (permission, name collision) skips this database and
      // keeps the rest; any other failure stops the import.
      if (!isImportRefusal(error)) throw error;
      result.databasesSkipped.push(file.path);
      continue;
    }
    result.collections++;
    for (const f of fields) if (f.ambiguousDate) result.ambiguousDateColumns.push({ path: file.path, column: f.name });

    // 2) Seed a table view + (when a select column exists) a kanban view so the
    //    imported database is immediately usable, not just a bag of attributes.
    const tagId = schemaId;
    await seedDefaultViews(workspaceId, tagId, fields, actor);

    // 3) One note per data row, with the page body attached.
    const seenNotionIds = new Set<string>();
    const folders = rowFolders(file.path, mdFiles);
    // A title two rows share cannot say which row its page belongs to.
    const titleCount = new Map<string, number>();
    for (const row of table.rows) {
      const key = titleKey(rowToItem(fields, table.header, row).title);
      titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
    }
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      const item = rowToItem(fields, table.header, row);

      // Dedup rows by Notion page id (a database split across views can list the
      // same row twice). Title-only rows fall through (no id to dedup on).
      if (item.notionId) {
        if (seenNotionIds.has(item.notionId)) { result.rowsSkipped++; continue; }
        seenNotionIds.add(item.notionId);
      }

      try {
        const created = await createImportedRow(workspaceId, schemaId, {
          title: importedRowTitle(titleField ? item.data[titleField] : undefined),
          data: item.data, fieldTypes: collectionFields, actor,
        });
        result.rows++;
        const titleCell = titleField ? item.data[titleField] : undefined;
        if (typeof titleCell === "string" && clampNoteTitle(titleCell.trim()) !== titleCell.trim()) {
          result.titlesTruncated.push({ path: file.path, row: r + 1 });
        }

        // Attach the matching page body (Notion `<Title> <hash>.md`).
        let body: MdFile | undefined = item.notionId ? byId.get(item.notionId) : undefined;
        if (!body && titleCount.get(titleKey(item.title)) === 1) {
          const candidates = [...folders].flatMap((dir) => byFolderTitle.get(folderTitleKey(dir, item.title)) ?? []);
          if (candidates.length === 1) body = candidates[0];
        }
        if (body && usedBodies.has(body.path)) body = undefined;
        if (body) {
          const cleaned = rewriteBody(cleanPageBody(body.content, item.title), body.path);
          const problem = noteSizeProblem({ markdown: cleaned });
          if (problem === "too_large") {
            result.bodiesSkipped.push({ path: body.path, reason: "too_large" });
            usedBodies.add(body.path);
            result.consumedMdPaths.add(body.path);
          } else if (problem === "contains_nul" || problem === "invalid_text") {
            // Not stored; the file stays unconsumed and is reported when it is
            // imported as a note of its own.
          } else if (cleaned.trim() !== "") {
            // The row is already in: a refused body leaves the file unconsumed (it
            // then lands as its own note) and the row is not also counted skipped.
            try {
              await attachBody(workspaceId, created.id, cleaned, actor);
              result.bodiesAttached++;
              usedBodies.add(body.path);
              result.consumedMdPaths.add(body.path);
            } catch (error) {
              if (!isImportRefusal(error)) throw error;
            }
          }
        }
      } catch (error) {
        if (!isImportRefusal(error)) throw error;
        result.rowsSkipped++;
      }
    }
  }

  return result;
}

/** The tag schema's views mapping (grid/detail + *_field). */
function buildSchemaViews(fields: InferredField[]): Record<string, unknown> {
  const v = defaultViews(fields);
  const mapping: Record<string, unknown> = {};
  if (v.title_field) mapping.title_field = v.title_field;
  return {
    grid: { ...mapping },
    detail: { ...mapping },
  };
}

/** Insert a table view and (if a select column exists) a kanban view grouped on
 *  it, plus a calendar view if a date column exists. Each needs its view module
 *  imported (appendTagView's gate): a layout the workspace removed is skipped,
 *  not swapped for another — the table is seeded anyway while Table is
 *  imported, and with Table removed too the collection gets no saved view.
 *  Best-effort: a refused view never fails the import. */
async function seedDefaultViews(
  workspaceId: string,
  tagId: string,
  fields: InferredField[],
  actor: ActorCtx,
): Promise<void> {
  const visible = fields.map((f) => f.name);
  const v = defaultViews(fields);

  const make = async (name: string, layout: ViewCreate["layout"], groupBy: string | null, layoutConfig: Record<string, unknown> = {}) => {
    try {
      // The same writer as POST /tags/:id/views: the view-module gate, the
      // stored element and the event. A name the tag already has is skipped.
      await withEventTransaction(workspaceId, () => appendTagView(actor, workspaceId, tagId, {
        name, layout, filters: [], sorts: [], group_by: groupBy,
        visible_fields: visible, layout_config: layoutConfig, pin_order: 0,
      }, { authority: { kind: "any_space_write" }, uiContext: "import.notion.view", skipNameClash: true }));
    } catch (error) {
      // A layout whose view module the workspace removed is skipped, as is a
      // refused view; a storage failure is not.
      if (!(error instanceof ModuleNotImportedError) && !isImportRefusal(error)) throw error;
    }
  };

  await make("Table", "table", null);
  if (v.group_field) await make("Board", "kanban", v.group_field);
  // The calendar's one setting is its date field (the layout's declared config), so the view says which.
  if (v.date_field) await make("Calendar", "calendar", null, { date_field: v.date_field });
}

/** Write the page body onto an already-created item node (NODE_UPDATED + blob)
 *  through the shared body pipeline (services/bodySideEffects.ts): wikilink
 *  edges, block ids, backup, module content hooks and the cascade, and an
 *  inverse patch so undoing it reverts the body — as importMarkdown does. */
async function attachBody(
  workspaceId: string,
  nodeId: string,
  body: string,
  actor: ActorCtx,
): Promise<void> {
  const bodyHash = await putBlob(body);
  const current = (await q<{ title: string; markdown: string | null }>(
    `SELECT title, markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, nodeId],
  )).rows[0]!;
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "node", nodeId, op: "write_node" },
    event: {
      type: "NODE_UPDATED",
      targetType: "node",
      targetId: nodeId,
      payload: { body_hash: bodyHash },
      txMeta: { ui_context: "import.notion.body", inverse_patch: makeInversePatch(current.markdown ?? "", body) },
    },
    apply: async ({ eventId }) => {
      await q(
        `UPDATE content_nodes SET markdown = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, nodeId, body],
      );
      if (body !== (current.markdown ?? "")) {
        await recordVersion({ workspaceId, noteId: nodeId, unit: "body", contentHash: bodyHash, kind: "updated", title: current.title });
      }
      await applyBodyChange({
        workspaceId, nodeId, title: current.title, markdown: body, previousMarkdown: current.markdown ?? "", eventId, actor,
        cascadeLabel: "import.notion.cascade", backupPrefix: "IMPORT (notion)",
      });
    },
  });
}
