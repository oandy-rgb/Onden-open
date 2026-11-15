// The drawing part of a folder import's result: how many Excalidraw drawings
// became handwriting notes, and what in them couldn't be drawn, and why.
import { useT } from "../../lib/i18n";
import type { DrawingReport } from "./drawingImport";

export default function DrawingImportReport({ result }: { result: Partial<DrawingReport> }) {
  const t = useT();
  const converted = result.drawings_converted ?? 0;
  const skips = result.drawing_skips ?? [];
  const unreadable = result.drawings_unreadable ?? [];
  if (!converted && !unreadable.length) return null;
  return (
    <>
      {converted > 0 && <span>{t("{count} drawings imported as handwriting notes", { count: converted })}</span>}
      {skips.length > 0 && (
        <details className="settings-import-warning">
          <summary>{t("Parts of drawings not converted ({count})", { count: skips.reduce((n, s) => n + s.count, 0) })}</summary>
          <ul>
            {skips.map((s, i) => <li key={i}>{s.path}: {s.count} × {s.type} — {t(s.reason)}</li>)}
          </ul>
        </details>
      )}
      {unreadable.length > 0 && (
        <details className="settings-import-warning">
          <summary>{t("Drawings that couldn't be read, imported as text ({count})", { count: unreadable.length })}</summary>
          <ul>{unreadable.map((path) => <li key={path}>{path}</li>)}</ul>
        </details>
      )}
    </>
  );
}
