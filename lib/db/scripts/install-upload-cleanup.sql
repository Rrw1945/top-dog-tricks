-- Aggregate-only operational state. Never store object paths or raw errors here.
CREATE TABLE IF NOT EXISTS entry_upload_cleanup_health (
  id integer PRIMARY KEY DEFAULT 1 CONSTRAINT entry_upload_cleanup_health_singleton CHECK (id = 1),
  total_runs integer NOT NULL DEFAULT 0,
  failed_runs integer NOT NULL DEFAULT 0,
  failed_objects integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_finished_at timestamptz,
  last_failure_at timestamptz
);
INSERT INTO entry_upload_cleanup_health (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS entry_uploads (
  object_path text PRIMARY KEY,
  state text NOT NULL DEFAULT 'issued',
  generation text,
  eligible_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entry_uploads_checked_idx ON entry_uploads (checked_at);
CREATE TABLE IF NOT EXISTS protected_media (object_path text PRIMARY KEY);

-- One token per source, not per URL shape. Sliding windows intentionally keep
-- substring semantics even for adjacent UUIDs and UUIDs embedded in longer text.
CREATE OR REPLACE FUNCTION entry_upload_reference_tokens(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT substring(run[1] FROM n FOR 36)), ARRAY[]::text[])
  FROM regexp_matches(value, '[a-f0-9-]{36,}', 'g') AS run
  CROSS JOIN LATERAL generate_series(1, length(run[1]) - 35) AS n;
$$;

CREATE TABLE IF NOT EXISTS entry_upload_references (
  token text NOT NULL,
  source_kind text NOT NULL,
  source_key text NOT NULL,
  PRIMARY KEY (token, source_kind, source_key)
);
CREATE INDEX IF NOT EXISTS entry_upload_references_source_idx
  ON entry_upload_references (source_kind, source_key);
CREATE INDEX IF NOT EXISTS entry_uploads_reference_id_idx
  ON entry_uploads (split_part(object_path, '/', 4));
CREATE INDEX IF NOT EXISTS entry_uploads_legacy_reference_idx
  ON entry_uploads (object_path)
  WHERE split_part(object_path, '/', 4) !~ '^[a-f0-9-]{36}$';

-- Installer is transactional. Block source writes through backfill and trigger
-- replacement so no committed reference can fall between the two.
LOCK TABLE submissions, protected_media IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION sync_entry_upload_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE source_id text; reference_text text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM entry_upload_references WHERE source_kind = TG_TABLE_NAME;
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    source_id := CASE WHEN TG_TABLE_NAME = 'submissions' THEN to_jsonb(OLD)->>'id'
      ELSE to_jsonb(OLD)->>'object_path' END;
    DELETE FROM entry_upload_references
      WHERE source_kind = TG_TABLE_NAME AND source_key = source_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'submissions' THEN
      source_id := NEW.id::text;
      reference_text := concat_ws(' ', NEW.video_object_path, NEW.signature_object_path,
        NEW.processed_video_object_path, NEW.voiceover_object_path);
    ELSE
      source_id := NEW.object_path;
      reference_text := NEW.object_path;
    END IF;
    INSERT INTO entry_upload_references (token, source_kind, source_key)
      SELECT unnest(entry_upload_reference_tokens(reference_text)), TG_TABLE_NAME, source_id
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS submission_upload_references ON submissions;
CREATE TRIGGER submission_upload_references AFTER INSERT OR UPDATE OR DELETE ON submissions
FOR EACH ROW EXECUTE FUNCTION sync_entry_upload_references();
DROP TRIGGER IF EXISTS admin_media_upload_references ON protected_media;
CREATE TRIGGER admin_media_upload_references AFTER INSERT OR UPDATE OR DELETE ON protected_media
FOR EACH ROW EXECUTE FUNCTION sync_entry_upload_references();
DROP TRIGGER IF EXISTS submission_upload_references_truncate ON submissions;
CREATE TRIGGER submission_upload_references_truncate AFTER TRUNCATE ON submissions
FOR EACH STATEMENT EXECUTE FUNCTION sync_entry_upload_references();
DROP TRIGGER IF EXISTS admin_media_upload_references_truncate ON protected_media;
CREATE TRIGGER admin_media_upload_references_truncate AFTER TRUNCATE ON protected_media
FOR EACH STATEMENT EXECUTE FUNCTION sync_entry_upload_references();

-- Rebuild also repairs stale derived data on a repeated installation.
DELETE FROM entry_upload_references;
INSERT INTO entry_upload_references (token, source_kind, source_key)
SELECT unnest(entry_upload_reference_tokens(concat_ws(' ', video_object_path,
  signature_object_path, processed_video_object_path, voiceover_object_path))), 'submissions', id::text
FROM submissions;
INSERT INTO entry_upload_references (token, source_kind, source_key)
SELECT unnest(entry_upload_reference_tokens(object_path)), 'protected_media', object_path
FROM protected_media;

CREATE OR REPLACE FUNCTION entry_upload_has_reference(value text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM entry_upload_references WHERE token = value);
$$;

-- Enforce coordination for every writer, including maintenance scripts.
-- UUID substring matching is deliberately conservative for full URL aliases.
CREATE OR REPLACE FUNCTION fence_entry_upload_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE upload record; row_text text; tokens text[];
BEGIN
  row_text := row_to_json(NEW)::text;
  tokens := entry_upload_reference_tokens(row_text);
  FOR upload IN
    SELECT object_path, state FROM entry_uploads
    WHERE object_path IN (
      SELECT object_path FROM entry_uploads
      WHERE split_part(object_path, '/', 4) = ANY(tokens)
      UNION ALL
      SELECT object_path FROM entry_uploads
      WHERE split_part(object_path, '/', 4) !~ '^[a-f0-9-]{36}$'
        AND position(split_part(object_path, '/', 4) in row_text) > 0
    )
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
