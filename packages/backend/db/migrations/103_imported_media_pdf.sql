-- A folder import stores a vault's PDFs too (2026-10-14): Obsidian notes embed
-- them as ![[paper.pdf]], which the import now rewrites to a link to the
-- stored file. imported_media (the import's content-hash → file index) only
-- allowed image extensions.
ALTER TABLE imported_media DROP CONSTRAINT IF EXISTS imported_media_extension_check;
ALTER TABLE imported_media ADD CONSTRAINT imported_media_extension_check
  CHECK (extension = ANY (ARRAY['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.pdf']));
