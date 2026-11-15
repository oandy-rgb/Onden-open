// One image of the site (標誌, 網站圖示): the current picture, 「上傳圖片」 and
// 「移除」. The desktop style panel and the phone studio both use it, so the
// upload, the accepted formats and the error handling are written once. The
// value is the stored `/api/media/…` address, kept out of sight; `onChange`
// is the same path as the site's name (settings → autosave), and "" removes.
import { useId, useRef, useState } from "react";
import { Button, FileInput, Img } from "../../../components/ui";
import { SITE_IMAGE_ACCEPT, isSiteImageName } from "@onden/markdown";
import { addToast } from "../../../lib/appStore";
import { uploadMedia, writeErrors } from "../../../lib/data";
import { useT } from "../../../lib/i18n";
import "./SiteImageField.css";

/** png, jpg, webp and svg: the pictures a nav bar or a browser tab can show. */

export default function SiteImageField({ label, hint, value, onChange }: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useT();
  const ids = { label: useId(), hint: useId(), file: useId() };
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!isSiteImageName(file.name)) {
      addToast(t("Choose a PNG, JPG, WebP or SVG image."), "error");
      return;
    }
    setUploading(true);
    try {
      // Not stored until the upload is accepted: a failure leaves the picture as it was.
      onChange(await uploadMedia(file));
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally { setUploading(false); }
  }

  return (
    <div className="hs-image" role="group" aria-labelledby={ids.label} aria-describedby={hint ? ids.hint : undefined}>
      <label id={ids.label} htmlFor={ids.file} className="hs-image__label">{label}</label>
      {hint && <p id={ids.hint} className="hs-image__hint">{hint}</p>}
      <div className="hs-image__row">
        {value && <Img className="hs-image__thumb" src={value} alt={t("Current picture: {name}", { name: label })} />}
        <Button className="hs-image__button" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? t("Uploading…") : t("Upload image")}
        </Button>
        {value && <Button className="hs-image__button" disabled={uploading} onClick={() => onChange("")}>{t("Remove")}</Button>}
      </div>
      <FileInput
        id={ids.file} ref={input} accept={SITE_IMAGE_ACCEPT} hidden
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void pick(file); }}
      />
    </div>
  );
}
