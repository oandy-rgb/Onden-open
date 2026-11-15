// rehype-sanitize allowlist additions for media-embed tags (part of the one
// schema, sanitizeSchema.ts).
//
// SAFETY: <iframe> is permitted here only with https-scheme src (enforced by
// rehype-sanitize's default `protocols.src`, which we keep) and ALWAYS carries
// sandbox + a referrerpolicy. The default schema does NOT allow `sandbox`/
// `allow`/`referrerpolicy`, so we add them. Crucially the *host* allowlist
// (YouTube/Vimeo only) is NOT expressible in the schema — each renderer drops
// any iframe whose src isn't a trusted provider. Allowing the tag in the
// schema without that render-time gate would let any https iframe through.

// New tags media embeds need beyond the default schema.
export const MEDIA_TAG_NAMES = ["video", "audio", "source", "iframe"] as const;

/** Returns the attribute-allowlist entries for the media tags, merged onto any
 *  pre-existing default-schema entries for those tags (defaultSchema has none
 *  for these, but we merge defensively). */
export function mediaSanitizeAttributes(
  base: Record<string, unknown[]> | null | undefined,
): Record<string, unknown[]> {
  const prev = (base ?? {}) as Record<string, unknown[]>;
  return {
    video: [
      ...(prev.video ?? []),
      "src", "controls", "width", "height", "poster", "preload",
      "loop", "muted", "playsInline", ["className", /^md-/],
    ],
    audio: [
      ...(prev.audio ?? []),
      "src", "controls", "preload", "loop", "muted", ["className", /^md-/],
    ],
    source: [...(prev.source ?? []), "src", "type"],
    iframe: [
      ...(prev.iframe ?? []),
      "src", "width", "height", "title", "allow", "allowFullScreen",
      "sandbox", "referrerPolicy", "loading", "frameBorder", ["className", /^md-/],
    ],
  };
}
