-- Treat every organization that already exists before the onboarding flow shipped
-- as onboarded, so established workspaces are not pushed back through onboarding.
-- New organizations provisioned after this migration are created without the flag
-- and go through the onboarding flow on first dashboard access.
UPDATE rend_auth.organization
SET
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'onboarding',
    COALESCE(metadata -> 'onboarding', '{}'::jsonb) || jsonb_build_object(
      'completed_at', to_jsonb(now()),
      'source', 'backfill_0013'
    )
  ),
  updated_at = now()
WHERE COALESCE(metadata -> 'onboarding' ->> 'completed_at', '') = '';
