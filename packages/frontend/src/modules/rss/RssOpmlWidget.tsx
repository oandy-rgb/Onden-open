import { useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import type { SettingContext } from "../../lib/settingsTypes";
import { reads, rssWriter, writeErrors } from "../../lib/data";
import { Button, FileInput, Link, buttonClass } from "../../components/ui";

// The RSS module's settings (its module card): OPML import/export — the standard
// way to carry a subscription list between readers. Follows the
// FolderImportWidget style (file picker → status line → result counts).

type Status = "idle" | "importing" | "done" | "error";

export default function RssOpmlWidget({ ctx }: { ctx: SettingContext }) {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus("importing");
    setError(null);
    try {
      const opml = await file.text();
      const res = await rssWriter.importOpml(opml);
      setResult(res);
      setStatus("done");
      ctx.onImportDone();
    } catch (err) {
      setError(writeErrors.message(err));
      setStatus("error");
    }
  }

  return (
    <>
      <div className="settings-row settings-row--actions">
        <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={status === "importing"}>
          {status === "importing" ? t("Importing…") : t("Import subscriptions (.opml)")}
        </Button>
        <Link className={buttonClass("secondary")} href={reads.modules.links.rssOpml()} download="onden-subscriptions.opml">
          {t("Export subscriptions (.opml)")}
        </Link>
      </div>
      <FileInput ref={fileRef} accept=".opml,.xml,text/xml" className="settings-file-input--hidden" onChange={(e) => void handleImport(e)} />
      {status === "done" && result && (
        <p className="settings-hint">{result.skipped > 0
          ? t(result.imported === 1 ? "Imported {n} feed, skipped {skipped} already subscribed. First articles arrive in Reading › RSS shortly." : "Imported {n} feeds, skipped {skipped} already subscribed. First articles arrive in Reading › RSS shortly.", { n: result.imported, skipped: result.skipped })
          : t(result.imported === 1 ? "Imported {n} feed. First articles arrive in Reading › RSS shortly." : "Imported {n} feeds. First articles arrive in Reading › RSS shortly.", { n: result.imported })}</p>
      )}
      {status === "error" && <p className="settings-hint">{error}</p>}
      {status === "idle" && (
        <p className="settings-hint">{t("Subscriptions are managed in Reading › RSS, where new articles arrive.")}</p>
      )}
    </>
  );
}
