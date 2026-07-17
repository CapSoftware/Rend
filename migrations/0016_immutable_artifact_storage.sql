ALTER TABLE rend.artifacts
  ADD COLUMN IF NOT EXISTS storage_object_key text;

UPDATE rend.artifacts
SET storage_object_key = object_key
WHERE storage_object_key IS NULL;

ALTER TABLE rend.artifacts
  ALTER COLUMN storage_object_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_storage_object_key_uidx
  ON rend.artifacts(storage_object_key);
