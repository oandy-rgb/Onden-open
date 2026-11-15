-- A folder import stores every kind of media file (D91, 2026-10-18): the
-- import reads the one media table (@onden/markdown mediaTypes.ts), so an
-- Onden export's audio, video and documents come back with it. imported_media
-- (the import's content-hash → file index) allowed images and PDFs only.
ALTER TABLE imported_media DROP CONSTRAINT IF EXISTS imported_media_extension_check;
ALTER TABLE imported_media ADD CONSTRAINT imported_media_extension_check
  CHECK (extension = ANY (ARRAY['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico',
    '.pdf', '.docx', '.xlsx', '.pptx', '.eml', '.txt',
    '.mp3', '.m4a', '.wav', '.oga', '.ogg', '.aac', '.flac',
    '.mp4', '.webm', '.mov', '.ogv']));
-- A minted name keeps its extension (mediaStore.opaqueMediaName), and .mp3,
-- .mp4 and .m4a hold digits.
ALTER TABLE imported_media DROP CONSTRAINT IF EXISTS imported_media_filename_check;
ALTER TABLE imported_media ADD CONSTRAINT imported_media_filename_check
  CHECK (filename ~ '^[0-9a-f]{32}\.[a-z0-9]+$');
