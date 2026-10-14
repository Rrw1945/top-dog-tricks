CREATE TABLE IF NOT EXISTS entry_uploads (
  object_path text PRIMARY KEY,
  state text NOT NULL DEFAULT 'issued',
  generation text,
  eligible_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entry_uploads_checked_idx ON entry_uploads (checked_at);
CREATE TABLE IF NOT EXISTS protected_media (object_path text PRIMARY KEY);

-- Enforce coordination for every writer, including maintenance scripts.
-- UUID substring matching is deliberately conservative for full URL aliases.
CREATE OR REPLACE FUNCTION fence_entry_upload_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE upload record;
BEGIN
  FOR upload IN
    SELECT object_path, state FROM entry_uploads
    WHERE position(split_part(object_path, '/', 4) in row_to_json(NEW)::text) > 0
    ORDER BY object_path FOR UPDATE
  LOOP
    IF upload.state IN ('deleting', 'deleted') THEN
      RAISE EXCEPTION 'Referenced upload has expired; upload the file again';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS submission_upload_fence ON submissions;
CREATE TRIGGER submission_upload_fence BEFORE INSERT OR UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION fence_entry_upload_reference();
DROP TRIGGER IF EXISTS admin_media_upload_fence ON protected_media;
CREATE TRIGGER admin_media_upload_fence BEFORE INSERT OR UPDATE ON protected_media
FOR EACH ROW EXECUTE FUNCTION fence_entry_upload_reference();
