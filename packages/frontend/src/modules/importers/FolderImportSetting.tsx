import { randomUUID } from "../../lib/uuid";
import { useEffect, useRef, useState } from "react";
import { capMegabytes, NODE_MARKDOWN_MAX, NODE_TITLE_MAX } from "@onden/markdown";
import { captureWriter, reads, WriteActionError, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { Button, Checkbox, FieldError, FileInput, Select, TextField } from "../../components/ui";
import { DataRow } from "../../settings/DataRow";
import type { SettingContext } from "../../lib/settingsTypes";
import DrawingImportReport from "./DrawingImportReport";
import { MAX_IMPORT_REQUEST_BYTES, importedMediaKind, isHiddenImportPath, uploadFolderImport, type FolderImportFile, type ImportResult, type SkippedNoteReason } from "./folderImport";
import type { ImportSource } from "@onden/contract";

// 「匯入資料夾」 in Your Data › Import: one chosen folder goes to POST
// /api/import/obsidian in batches (folderImport.ts).

type ImportStatus = "idle" | "reading" | "ready" | "importing" | "done" | "error";
/** Where Obsidian's .trash goes when imported. A fixed name, not translated:
 *  re-importing in another language must find the same folder. */
const TRASH_FOLDER = "Obsidian 垃圾桶";
/** A file the import did not bring in, and why (shown as one list). */
type SkippedFile = { path: string; reason: string };

export default function FolderImportSetting({ ctx }: { ctx: SettingContext }) {
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [fileCount, setFileCount] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [selectedSource, setSelectedSource] = useState("new");
  const [sourceName, setSourceName] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [progress, setProgress] = useState<{ batch: number; batches: number } | null>(null);
  // What reading the folder left out locally: hidden paths (.obsidian, .git,
  // .trash …) are counted; unsupported files are listed with the result.
  // Obsidian's trash (.trash) is imported only when asked: its notes go under
  // TRASH_FOLDER, keeping their subfolders; otherwise the result counts them.
  const pending = useRef<{ files: FolderImportFile[]; trash: FolderImportFile[]; unsupported: string[]; extensions: string[]; hidden: number } | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [localSkips, setLocalSkips] = useState<{ skipped: SkippedFile[]; hidden: number; trash: number }>({ skipped: [], hidden: 0, trash: 0 });
  const folderRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const tr = useT();

  useEffect(() => {
    let active = true;
    reads.modules.importers.sources<ImportSource>().then(result => {
      if (active) setSources(current => [...new Map([...(result.sources ?? []),...current].map(source => [source.id,source])).values()]);
    }).catch(failure => {
      if (active) setSourceError(writeErrors.message(failure));
    });
    return () => { active = false; };
  }, []);

  async function handleFolderImport(fileList: FileList) {
    if (busy.current) return;
    busy.current = true;
    setStatus("reading");
    setError(null);
    try {
      const extLower = (n: string) => { const i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i).toLowerCase(); };
      const bufToBase64 = (buf: ArrayBuffer): string => {
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        return btoa(bin);
      };
      const files: FolderImportFile[] = [];
      const first = fileList[0];
      const chosenName = first?.webkitRelativePath.split("/")[0] || tr("Selected files");
      setFolderName(chosenName);
      if (selectedSource === "new") setSourceName(chosenName);
      const localUnsupported: string[] = [];
      const localUnsupportedExts = new Set<string>();
      let hidden = 0;
      const trash: FolderImportFile[] = [];
      for (const file of Array.from(fileList)) {
        const rel = file.webkitRelativePath || file.name;
        const pathParts = rel.split("/");
        const inner = pathParts.length > 1 ? pathParts.slice(1) : pathParts;
        if (inner[0] === ".trash" && inner.length > 1 && !inner.slice(1).some(part => part.startsWith(".")) && extLower(file.name) === ".md") {
          trash.push({ path: [TRASH_FOLDER, ...inner.slice(1)].join("/"), content: await file.text() });
          continue;
        }
        if (isHiddenImportPath(rel)) { hidden++; continue; }
        const path = pathParts.length > 1 ? pathParts.slice(1).join("/") : rel;
        const ext = extLower(file.name);
        if (ext === ".md" || ext === ".csv") files.push({ path, content: await file.text() });
        // Any file on the media table is stored; notes link to it or embed
        // it (![[paper.pdf]], ![[song.mp3]], an export's attachments/).
        else if (importedMediaKind(file.name)) files.push({ path, base64: bufToBase64(await file.arrayBuffer()), kind: importedMediaKind(file.name)! });
        else { localUnsupported.push(path); if (ext) localUnsupportedExts.add(ext); }
      }
      setFileCount(files.length);
      setTrashCount(trash.length);
      setIncludeTrash(false);
      if (files.length === 0 && trash.length === 0) {
        setResult({ imported: 0, skipped: 0, folders: 0, unsupported_files: localUnsupported.length, unsupported_exts: [...localUnsupportedExts].sort() });
        setLocalSkips({ skipped: localUnsupported.map(path => ({ path, reason: tr("Unsupported file type") })), hidden, trash: 0 });
        setStatus("done");
        return;
      }
      pending.current = { files,trash,unsupported:localUnsupported,extensions:[...localUnsupportedExts],hidden };
      setStatus("ready");
    } catch (failure) {
      pending.current = null;
      setError(writeErrors.message(new WriteActionError(tr("Could not read the selected files. Nothing was uploaded. Choose the folder again."), { cause:failure })));
      setStatus("error");
    } finally {
      busy.current = false;
      if (folderRef.current) folderRef.current.value = "";
    }
  }

  async function submitImport() {
    const upload = pending.current;
    if (!upload || busy.current) return;
    const source = selectedSource === "new"
      ? { id:randomUUID(),name:sourceName.trim() }
      : sources.find(candidate => candidate.id === selectedSource);
    if (!source?.name) return;
    // Keep the chosen ID after an uncertain response, so retrying this mounted
    // form does not silently switch to a new source. The server list survives
    // reload after at least one imported node/folder has committed.
    setSources(current => [...new Map([...current,source].map(value => [value.id,value])).values()]);
    setSelectedSource(source.id);
    busy.current = true;
    setStatus("importing");
    setError(null);
    setProgress(null);
    try {
      // settings/folderImport.ts: batches under the proxy limit, one result.
      const { result: res, tooLarge } = await uploadFolderImport({ files:includeTrash ? [...upload.files,...upload.trash] : upload.files, source,
        send: body => captureWriter.importObsidian<ImportResult>(body),
        onProgress: setProgress });
      setResult({ ...res,unsupported_files:(res.unsupported_files ?? 0)+upload.unsupported.length,
        unsupported_exts:[...new Set([...(res.unsupported_exts ?? []),...upload.extensions])].sort() });
      setLocalSkips({ hidden: upload.hidden, trash: includeTrash ? 0 : upload.trash.length, skipped: [
        ...tooLarge.map(({ path, kind }) => ({ path, reason: kind === "collection"
          ? tr("Database too large to upload with its pages (over {mb} MB); not imported", { mb: capMegabytes(MAX_IMPORT_REQUEST_BYTES) })
          : tr("Too large to upload (over {mb} MB)", { mb: capMegabytes(MAX_IMPORT_REQUEST_BYTES) }) })),
        ...upload.unsupported.map(path => ({ path, reason: tr("Unsupported file type") })),
      ] });
      setStatus("done");
      pending.current = null;
      try { await ctx.onImportDone(); }
      catch (failure) {
        console.error("[onden] refresh after folder import failed",failure);
        setError(tr("Import finished, but the note list could not refresh. Reload the page to see the result."));
      }
    } catch (failure) {
      setError(`${writeErrors.message(failure)} ${tr("Some files may already be imported. Choose the folder again and import into the same source: imported notes are kept and only the missing ones are added.")}`);
      setStatus("error");
    } finally { busy.current = false; }
  }

  const conflictMessage = (reason: SkippedNoteReason) => tr({
    local_changes:"Kept your changes in Onden",
    history_incomplete:"No reliable previous import to compare; original kept",
    ambiguous:"More than one matching note; originals kept",
    unavailable:"Note unavailable or permission denied; nothing replaced",
    invalid_tag_name:"One of its tags has a name a tag can't have (/ # , : { }); not imported",
    folder_unavailable:"Its folder could not be created or reused; not imported",
    database_unavailable:"A tag with this name already exists or is not allowed, so the database was not created",
    too_large:"Over the {max}-character note limit; not imported",
    invalid_text:"Contains a character that can't be saved (an empty or broken character); not imported",
  }[reason], { max: NODE_MARKDOWN_MAX.toLocaleString("en-US") });
  const imageSkipMessage = (reason: "too_large" | "unreadable") => tr({
    too_large:"Image too large",
    unreadable:"Not a readable file of its type",
  }[reason]);
  const skippedFiles: SkippedFile[] = result ? [
    ...(result.conflicts ?? []).map(conflict => ({ path:conflict.path,reason:conflictMessage(conflict.reason) })),
    ...(result.skipped_images ?? []).map(image => ({ path:image.path,reason:imageSkipMessage(image.reason) })),
    ...localSkips.skipped,
  ] : [];

  return (
    <div className="settings-folder-import">
      <DataRow
        title={tr("Import a folder")}
        hint={tr("Markdown becomes notes, CSV becomes collections, subfolders are kept. Only notes you haven't changed in Onden are updated.")}
        action={status === "idle" && (
          <Button variant="secondary" onClick={() => folderRef.current?.click()}>{tr("Choose folder…")}</Button>
        )}
      />
      <FileInput ref={folderRef} className="settings-file-input--hidden" aria-label={tr("Folder to import")}
        // @ts-expect-error webkitdirectory is non-standard
        webkitdirectory="" multiple
        onChange={(e) => { if (e.target.files?.length) void handleFolderImport(e.target.files); }} />
      {status === "ready" && (
        <div className="settings-import-review">
          <p className="settings-hint">{tr("Ready: {folder} ({count} files)", { folder:folderName,count:fileCount })}</p>
          <label className="settings-import-field">
            <span>{tr("Import destination")}</span>
            <Select className="settings-input" value={selectedSource} onChange={event => setSelectedSource(event.target.value)}>
              <option value="new">{tr("Create a separate import")}</option>
              {sources.map((source,index) => <option key={source.id} value={source.id}>{tr("Update: {name}", {name:source.id === "legacy" ? tr("Older imports") : source.name})}{sources.filter(other => other.name === source.name).length > 1 ? ` (${index+1})` : ""}</option>)}
            </Select>
          </label>
          {selectedSource === "new" && <label className="settings-import-field">
            <span>{tr("Source name")}</span>
            <TextField className="settings-input" value={sourceName} maxLength={200} onChange={event => setSourceName(event.target.value)} />
          </label>}
          <p className="settings-hint">{selectedSource === "new"
            ? tr("Creates separate notes even when folder names match. Use this source next time to update them.")
            : tr("Only this source's matching paths are checked. Notes changed in Onden are kept and listed for review.")}</p>
          {sourceError && <FieldError>{tr("Previous imports could not be loaded.")} {sourceError}</FieldError>}
          {trashCount > 0 && <label className="settings-hint settings-hint--checkbox">
            <Checkbox checked={includeTrash} onChange={event => setIncludeTrash(event.target.checked)} />
            {tr("Also import Obsidian's trash (.trash, {count} notes)", { count: trashCount })}
          </label>}
          <div className="settings-row settings-row--actions">
            <Button variant="primary" disabled={(selectedSource === "new" && !sourceName.trim()) || (fileCount === 0 && !includeTrash)} onClick={() => { void submitImport(); }}>{tr("Start import")}</Button>
            <Button variant="secondary" onClick={() => { pending.current=null;setStatus("idle"); }}>{tr("Choose another folder")}</Button>
          </div>
        </div>
      )}
      {status === "reading" && <p className="settings-hint" role="status">{tr("Reading files…")}</p>}
      {status === "importing" && <p className="settings-hint" role="status">{tr("Importing {count} files…", { count: fileCount })}{progress && progress.batches > 1 ? ` ${tr("(part {batch} of {batches})", progress)}` : ""}</p>}
      {status === "done" && result && (
        <div className="settings-import-result-list" role="status">
          <span>{tr("{count} notes imported", { count: result.imported })}</span>
          {(result.updated ?? 0) > 0 && <span>{tr("{count} notes updated", { count: result.updated! })}</span>}
          {(result.unchanged ?? 0) > 0 && <span>{tr("{count} notes unchanged", { count: result.unchanged! })}</span>}
          {(result.collections_imported ?? 0) > 0 && <span>{tr("{count} collections imported ({rows} rows)", { count: result.collections_imported!, rows: result.collection_rows_imported ?? 0 })}</span>}
          <DrawingImportReport result={result} />
          {(result.collection_bodies_attached ?? 0) > 0 && <span>{tr("{count} page bodies attached", { count: result.collection_bodies_attached! })}</span>}
          {(result.collection_rows_skipped ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} collection rows skipped", { count: result.collection_rows_skipped! })}</span>}
          {(result.images_imported ?? 0) - (result.pdfs_imported ?? 0) > 0 && <span>{tr("{count} images imported", { count: result.images_imported! - (result.pdfs_imported ?? 0) })}</span>}
          {(result.pdfs_imported ?? 0) > 0 && <span>{tr("{count} PDFs imported", { count: result.pdfs_imported! })}</span>}
          {(result.images_reused ?? 0) > 0 && <span>{tr("{count} images reused", { count: result.images_reused! })}</span>}
          {(result.image_refs_unresolved ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} image references could not be matched; original references were kept", { count: result.image_refs_unresolved! })}</span>}
          {(result.relations_resolved ?? 0) > 0 && <span>{tr("{count} relations linked", { count: result.relations_resolved! })}</span>}
          {!!result.unresolved_relations?.length && <details className="settings-import-conflicts">
            <summary className="settings-import-warning">{tr("{count} relations could not be matched to a note; their [[link]] text was kept", { count: result.unresolved_relations.length })}</summary>
            <ul>{result.unresolved_relations.map(relation => <li key={`${relation.path}\u0000${relation.key}`}><span>{relation.path} · {relation.key}</span><span>{relation.value}</span></li>)}</ul>
          </details>}
          {result.folders > 0 && <span>{tr("{count} folders created", { count: result.folders })}</span>}
          {(result.folders_reused ?? 0) > 0 && <span>{tr("{count} folders reused", { count: result.folders_reused! })}</span>}
          {(result.folders_skipped ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} folders skipped; their notes were not moved to the root", { count: result.folders_skipped! })}</span>}
          {result.skipped > 0 && <span className="settings-import-warning">{tr("{count} notes skipped", { count: result.skipped })}</span>}
          {!!result.titles_truncated?.length && <details className="settings-import-conflicts">
            <summary>{tr("Titles shortened to {max} characters ({count})", { max: NODE_TITLE_MAX, count: result.titles_truncated.length })}</summary>
            <ul>{result.titles_truncated.map(entry => <li key={`${entry.path}#${entry.row ?? ""}`}><span>{entry.path}</span>{entry.row !== undefined && <span>{tr("Row {row}", { row: entry.row })}</span>}</li>)}</ul>
          </details>}
          {!!result.ambiguous_date_columns?.length && <details className="settings-import-conflicts">
            <summary>{tr("Date columns kept as text; day and month order is unclear ({count})", { count: result.ambiguous_date_columns.length })}</summary>
            <ul>{result.ambiguous_date_columns.map(entry => <li key={`${entry.path}#${entry.column}`}><span>{entry.path}</span><span>{entry.column}</span></li>)}</ul>
          </details>}
          {!!skippedFiles.length && <details className="settings-import-conflicts" open>
            <summary>{tr("Files not imported ({count})", {count:skippedFiles.length})}</summary>
            <ul>{skippedFiles.map(file => <li key={file.path}><span>{file.path}</span><span>{file.reason}</span></li>)}</ul>
          </details>}
          {localSkips.trash > 0 && <span>{tr("{count} notes in Obsidian's trash (.trash) not imported", { count: localSkips.trash })}</span>}
          {localSkips.hidden > 0 && <span>{tr("{count} hidden files left out (names starting with “.”, such as .obsidian)", { count: localSkips.hidden })}</span>}
          {(result.images_skipped ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} images skipped", { count: result.images_skipped! })}</span>}
          {(result.checkboxes_not_tasks ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} checkbox lines came in as plain checkboxes, not tasks", { count: result.checkboxes_not_tasks! })}{(result.checkboxes_with_dates ?? 0) > 0 ? tr(" ({dated} with a date that stays as text)", { dated: result.checkboxes_with_dates! }) : ""}</span>}
          {(result.unsupported_files ?? 0) > 0 && <span className="settings-import-warning">{tr("{count} unsupported files skipped", { count: result.unsupported_files! })}{result.unsupported_exts?.length ? ` (${result.unsupported_exts.join(", ")})` : ""}</span>}
          <Button variant="secondary" className="settings-btn--inline-action settings-btn--with-top-margin" onClick={() => { setError(null); setStatus("idle"); }}>
            {tr("Import another folder")}
          </Button>
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      {status === "error" && <Button variant="secondary" className="settings-btn--inline-action" onClick={() => { setError(null); setStatus("idle"); }}>{tr("Choose folder again")}</Button>}
    </div>
  );
}
