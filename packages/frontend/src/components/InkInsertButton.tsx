import { Camera, Image as ImageIcon, Plus } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { acceptFor } from "@onden/markdown";
import { useT } from "../lib/i18n";
import { FileInput, Menu, MenuItem, Pressable, usePopover } from "./ui";

// The toolbar's 「插入」 button: one button that opens two choices — a picture
// from the photo library or a file, or a photo taken now with the camera. The
// camera is the file picker told to prefer the back camera
// (`capture="environment"`): no camera stream of our own, so it works wherever
// the browser offers a camera and is the ordinary file picker where it does not.
// What comes back is the host's to upload and place (`onFiles`).

const IMAGE_ACCEPT = acceptFor("image");

export default function InkInsertButton({ onFiles, busy = false }: {
  /** The picture files the person chose. */
  onFiles: (files: File[]) => void;
  /** An upload is running: the button says so and does not stack another menu. */
  busy?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const label = t("Insert");
  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // the same photo can be chosen again
    if (files.length > 0) onFiles(files);
  };
  return (
    <>
      <Pressable
        ref={pop.anchor as React.RefObject<HTMLButtonElement>}
        type="button"
        className={open || busy ? "ink-tool-btn active" : "ink-tool-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        aria-label={busy ? t("Uploading…") : label}
        title={busy ? t("Uploading…") : label}
        data-ink-insert=""
      ><Plus size={15} /></Pressable>
      {open && (
        <Menu popover={pop} label={label} className="ink-insert-menu">
          <MenuItem onSelect={() => library.current?.click()} data-ink-insert-library="">
            <ImageIcon size={15} aria-hidden="true" />{t("Picture from photos or files")}
          </MenuItem>
          <MenuItem onSelect={() => camera.current?.click()} data-ink-insert-camera="">
            <Camera size={15} aria-hidden="true" />{t("Take a photo")}
          </MenuItem>
        </Menu>
      )}
      <FileInput ref={library} accept={IMAGE_ACCEPT} multiple hidden onChange={chosen} data-ink-insert-input="library" />
      <FileInput ref={camera} accept="image/*" capture="environment" hidden onChange={chosen} data-ink-insert-input="camera" />
    </>
  );
}
