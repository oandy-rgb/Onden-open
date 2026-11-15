import { useCallback, useState } from "react";
import { mediaRefs, mediaUrl } from "@onden/markdown";
import { addToast } from "../lib/appStore";
import { WriteActionError, uploadMedia, writeErrors } from "../lib/data";
import { t } from "../lib/i18n";

/** A picture that has been uploaded: its address and its proportions. */
export type UploadedImage = {
  /** `/api/media/<id>` — what a page stores (@onden/markdown/page-images). */
  src: string;
  /** The file's name without its extension. */
  alt: string;
  /** The picture's own size in pixels; null when the browser could not read it. */
  natural: { width: number; height: number } | null;
};

/** How long to wait for the browser to read a picture's size before placing it
 *  at a default proportion: a picture is inserted either way. */
const MEASURE_TIMEOUT_MS = 3000;

/** The size of a picture file as the browser draws it (a phone photo's
 *  rotation applied). null when it cannot be decoded (or takes too long). */
export function measureImage(file: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);
    const done = (size: { width: number; height: number } | null) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(size); };
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** Upload picture files the way `/` insert and drag-and-drop do (lib/data
 *  uploadMedia: one size/type check, one message) and say what came back. A
 *  file that fails is reported in the person's words and skipped; the others
 *  still go. `busy` is true while any upload runs. */
export function useImageUpload(): { upload: (files: readonly File[]) => Promise<UploadedImage[]>; busy: boolean } {
  const [running, setRunning] = useState(0);
  const upload = useCallback(async (files: readonly File[]): Promise<UploadedImage[]> => {
    setRunning((n) => n + 1);
    try {
      const done: UploadedImage[] = [];
      for (const file of files) {
        try {
          const [natural, url] = await Promise.all([measureImage(file), uploadMedia(file)]);
          const id = mediaRefs(url)[0];
          if (!id) throw new WriteActionError(t("The upload did not return a file address."));
          done.push({ src: mediaUrl(id), alt: file.name.replace(/\.[^.]+$/, ""), natural });
        } catch (error) {
          writeErrors.report(error, addToast);
        }
      }
      return done;
    } finally {
      setRunning((n) => n - 1);
    }
  }, []);
  return { upload, busy: running > 0 };
}
