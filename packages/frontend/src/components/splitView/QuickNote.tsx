import { useState } from "react";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { loadRssQuote } from "../../modules";
import { Button, TextField } from "../ui";

/** 「記一下」: a line typed here goes to the end of the note the pane shows,
 *  through the normal note writer (rssQuote.appendToNote: optimistic, sent or
 *  durably queued, merged with edits made elsewhere). The text stays in the box
 *  until the write is accepted or queued, so a refusal loses nothing. */
export default function QuickNote({ noteId, onWritten }: { noteId: string; onWritten?: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const line = text.trim();
    if (!line || busy) return;
    setBusy(true);
    try {
      const result = await (await loadRssQuote()).appendToNote(noteId, line);
      setText("");
      if (result.status === "queued") addToast(writeErrors.queuedMessage(), "info");
      onWritten?.();
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally { setBusy(false); }
  }

  return (
    <form className="split-quick" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <TextField className="ui-text-input split-quick-input" value={text} aria-label={t("Jot down")} placeholder={t("Jot down…")}
        onChange={(event) => setText(event.target.value)} disabled={busy} />
      <Button type="submit" variant="primary" disabled={busy || text.trim() === ""}>{t("Add")}</Button>
    </form>
  );
}
