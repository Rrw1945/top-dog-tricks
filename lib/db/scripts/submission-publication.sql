-- Run before serving code that reads published_at. Transactional and repeatable.
BEGIN;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS published_at timestamptz;
LOCK TABLE submissions IN SHARE ROW EXCLUSIVE MODE;

-- An approved processed asset is evidence of historical publication, even if
-- currently being reprocessed. Its actual publication date is not recoverable.
-- Epoch is an explicit unknown-date marker, NOT a claimed publication instant.
UPDATE submissions
SET published_at = '1970-01-01T00:00:00Z'::timestamptz
WHERE published_at IS NULL AND status = 'approved'
  AND processed_video_object_path IS NOT NULL;

CREATE OR REPLACE FUNCTION preserve_submission_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL THEN
    NEW.published_at := OLD.published_at;
  ELSIF NEW.status = 'approved' AND NEW.processing_status = 'completed'
        AND NEW.processed_video_object_path IS NOT NULL THEN
    NEW.published_at := clock_timestamp();
  ELSE
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS submissions_first_publication ON submissions;
CREATE TRIGGER submissions_first_publication
BEFORE INSERT OR UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION preserve_submission_publication();
COMMIT;
