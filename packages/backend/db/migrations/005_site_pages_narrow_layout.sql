DO $$
BEGIN
  BEGIN ALTER TABLE site_pages DROP CONSTRAINT site_pages_layout_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE site_pages ADD CONSTRAINT site_pages_layout_check
    CHECK (layout IN ('full', 'narrow', 'sidebar-left', 'sidebar-right'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
