import { runBackgroundWrite, uploadMedia } from "../../lib/data";
// Media (file or URL) editor — paste a URL or click to upload via /api/media.
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.
//
// Stored value is the URL either way; downstream consumers (renderers)
// don't need to know which path it came from.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { isEnterKey } from "../../lib/keys";
import { Pressable, TextField } from "../ui";
import { appendToBody, createElement } from "../../lib/documentAccess";

export function MediaFieldEditor({
  value, onSave,
}: {
  value: string;
  onSave: (next: string) => Promise<void> | void;
}) {
  const t = useT();
  const [uploading, setUploading] = useState(false);
  // The URL is typed into a local draft and saved once, on blur or Enter.
  // Saving every keystroke while the box was refilled from each save's result
  // stored fragments like "hts/og" (GAP-133).
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) runBackgroundWrite(onSave(draft)); };

  const handleUpload = useCallback(async () => {
    return new Promise<void>((resolve) => {
      const input = createElement("input");
      input.type = "file";
      input.style.display = "none";
      appendToBody(input);
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) { resolve(); return; }
          setUploading(true);
          // A failed upload is reported (it used to end silently).
          await onSave(await uploadMedia(file));
        } catch (error) {
          runBackgroundWrite(Promise.reject(error));
        } finally {
          input.remove();
          setUploading(false);
          resolve();
        }
      };
      input.click();
    });
  }, [onSave]);

  return (
    <div className="attr-media-editor">
      <TextField
        className="attr-input attr-input--value"
        type="url"
        placeholder={t("URL or upload →")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (isEnterKey(e)) commit(); }}
      />
      <Pressable
        className="attr-media-upload"
        onClick={() => void handleUpload()}
        disabled={uploading}
        title={t("Upload a file")}
      >
        {uploading ? "…" : "📎"}
      </Pressable>
    </div>
  );
}
