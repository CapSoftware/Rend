WITH ranked_verifications AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY identifier
      ORDER BY created_at DESC, id DESC
    ) AS row_number
  FROM rend_auth.verification
)
DELETE FROM rend_auth.verification verification
USING ranked_verifications ranked
WHERE verification.id = ranked.id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS rend_auth.verification_identifier_idx;

CREATE UNIQUE INDEX verification_identifier_idx
  ON rend_auth.verification(identifier);
