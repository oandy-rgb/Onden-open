-- Every reference claims an upload (audit D56; services/mediaOwners.ts).
--
-- Until now only a note's title or body claimed an uploaded file. Files
-- referenced only from an attribute (a media field's cover, the site's logo
-- or favicon) or a presentation (a page design, the site chrome) stayed
-- unclaimed and were judged by the oldest note referencing them: pasting the
-- URL into the body of a note in a shared space claimed a private note's
-- cover for that space, and adding it to an older note handed that note the
-- file. Attribute and presentation writes now claim too, and canReadMedia no
-- longer applies the oldest-reference rule to an upload; an unclaimed upload
-- is its uploader's alone.
--
-- Files uploaded before: claim each for the note that decides for it today,
-- the oldest one referencing it from its body, an attribute or its
-- presentation, live or trashed (the old fallback's choice), so the note
-- that decides for members stays the same. What changes is the claimed rule
-- itself: an anonymous reader needs that note (not any referencing note) on
-- the public site, and the uploader may always read the file.
--
-- Not an order by when each reference was added: only attribute writes
-- record their value in an event, so that order would compare an exact time
-- with a note's creation time and could hand a file to a note that does not
-- decide for it today. Files already claimed are left alone. Idempotent: a
-- claimed file no longer matches.
UPDATE media_uploads m SET node_id = (
  SELECT n.id FROM content_nodes n
   WHERE n.workspace_id = m.workspace_id
     AND (strpos(lower(coalesce(n.markdown, '')), lower('/api/media/' || m.filename)) > 0
          OR strpos(lower(coalesce(n.presentation::text, '')), lower('/api/media/' || m.filename)) > 0
          OR EXISTS (SELECT 1 FROM node_attributes na
                      WHERE na.node_id = n.id
                        AND strpos(lower(na.value), lower('/api/media/' || m.filename)) > 0))
   ORDER BY n.created_at, n.id
   LIMIT 1)
 WHERE m.node_id IS NULL;
