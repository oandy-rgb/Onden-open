// M3.3 — Gallery layout renderer.
//
// Responsive card grid: each row becomes a card with a cover image
// (first media-ish attribute, or a `cover`/`image`/`thumbnail` field),
// the title, and the remaining visible_fields as compact key/value
// badges. Sibling of TableLayout — it consumes the same
// ExecResponse row shape and only differs in presentation.
//
// Cover-image resolution is @onden/markdown mediaSrc: a bare media id (no
// scheme, not absolute) is served from /api/media/<id>.

import { Pressable } from "../../components/ui";
import { BUILT_IN_FIELDS, mediaSrc, graphemes, isImageName, isSafeImageSrc, SAFE_DATA_IMAGE_SRC } from "@onden/markdown";
import { getApiBase } from "../../lib/api";
import type { ExecResponse } from "../../lib/viewExec";
import { fieldValue } from "../../components/viewLayoutKit";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../../components/EmptyState";
import { Img } from "../../components/ui";
import type { ExecRow } from "@onden/contract";

type Props = {
  exec: ExecResponse;
  onSelectNode?: (id: string) => void;
};

// Field names that, by convention, hold a cover/preview image.
const COVER_FIELD_HINTS = ["cover", "image", "thumbnail", "thumb", "photo", "banner"];

// A value looks like an image if it is an absolute http(s) or site-relative
// address ending in an image extension, or a data: image URL. Anything else is
// treated as a bare media id (resolved through /api/media/) only when its
// field name hints that it is media.

const resolveMediaSrc = (src: string) => mediaSrc(src, { apiBase: getApiBase() });

function looksLikeImage(value: string): boolean {
  return (isSafeImageSrc(value) && isImageName(value)) || SAFE_DATA_IMAGE_SRC.test(value);
}

// Pick the cover image src for a card: the view's own `cover_field` (chosen
// when the cards view was added) when set, else scanning the visible fields:
//  1. a field whose name hints at media (cover/image/…) with any value, or
//  2. the first field whose value looks like an image URL.
// Returns the raw value (caller resolves to a src) or null.
function pickCover(row: ExecRow, fields: string[], configured?: unknown): string | null {
  if (typeof configured === "string" && configured) return row.attributes[configured] || null;
  for (const f of fields) {
    if (BUILT_IN_FIELDS.has(f)) continue;
    const name = f.toLowerCase();
    if (COVER_FIELD_HINTS.some((h) => name.includes(h))) {
      const v = row.attributes[f];
      if (v) return v;
    }
  }
  for (const f of fields) {
    if (BUILT_IN_FIELDS.has(f)) continue;
    const v = row.attributes[f];
    if (v && looksLikeImage(v)) return v;
  }
  return null;
}

function badgeValue(row: ExecRow, field: string): string | null {
  if (field === "title") return null;
  if (field === "updated_at") return dateLabel(row.updated_at, "numeric") || null;
  return fieldValue(row, field);
}

export default function GalleryLayout({ exec, onSelectNode }: Props) {
  const t = useT();
  if (exec.rows.length === 0) {
    return <EmptyState size="inline" title={t("No rows match the current filters.")} />;
  }

  // Cover field(s) are shown as the card image, not repeated as a badge.
  const visible = exec.view.visible_fields;
  const badgeFields = visible.filter((f) => {
    if (f === "title") return false;
    const name = f.toLowerCase();
    return !COVER_FIELD_HINTS.some((h) => name.includes(h));
  });

  return (
    <div className="cv-gallery">
      {exec.rows.map((row) => {
        const cover = pickCover(row, visible, exec.view.layout_config?.cover_field);
        const title = displayTitle(row.title);
        return (
          <Pressable
            key={row.id}
            type="button"
            className="cv-gallery-card"
            onClick={() => onSelectNode?.(row.id)}
            disabled={!onSelectNode}
            title={t("Open this note")}
          >
            <div className="cv-gallery-cover">
              {cover ? (
                <Img src={resolveMediaSrc(cover)} alt="" loading="lazy" />
              ) : (
                <span className="cv-gallery-cover-placeholder" aria-hidden="true">
                  {graphemes(title)[0]?.toUpperCase() || "·"}
                </span>
              )}
            </div>
            <div className="cv-gallery-body">
              <strong className="cv-gallery-title">{title}</strong>
              {badgeFields.length > 0 && (
                <div className="cv-gallery-badges">
                  {badgeFields.map((f) => {
                    const v = badgeValue(row, f);
                    if (!v) return null;
                    return (
                      <span key={f} className="cv-gallery-badge" title={f}>
                        <span className="cv-gallery-badge-key">{f}</span>
                        <span className="cv-gallery-badge-val">{v}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </Pressable>
        );
      })}
    </div>
  );
}
