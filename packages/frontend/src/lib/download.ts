/** Saves `blob` as a file through the browser's own download. The one place
 *  that does it: the link is attached while it is clicked (Firefox ignores a
 *  detached one) and the object URL is revoked late (Safari starts reading it
 *  after the click returns). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
