-- Safe to reapply. Existing volumes need this migration before the updated API starts.
BEGIN;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS email_attempt_id uuid;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS email_delivery_started_at timestamptz;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS email_message_id text;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_attempt_started_at timestamptz;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_attempt_id uuid;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_delivery_started_at timestamptz;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_message_id text;

ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_email_status_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_email_status_check
  CHECK (email_status IN ('pending','sending','sent','failed','unknown'));
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_reminder_status_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_reminder_status_check
  CHECK (reminder_status IN ('pending','sending','sent','failed','unknown'));

-- A historical 'sending' row has no delivery phase marker: never assume it is safe to resend.
UPDATE interviews SET email_delivery_started_at=COALESCE(email_attempt_started_at,now())
  WHERE email_status='sending' AND email_attempt_id IS NULL AND email_delivery_started_at IS NULL;
UPDATE interviews SET reminder_attempt_started_at=COALESCE(reminder_attempt_started_at,now()-interval '4 minutes'),
  reminder_delivery_started_at=COALESCE(reminder_delivery_started_at,now())
  WHERE reminder_status='sending' AND reminder_attempt_id IS NULL AND reminder_delivery_started_at IS NULL;
-- Repair previously acknowledged mail even if a later audit failure changed its status.
UPDATE interviews SET email_status='sent',email_error=NULL WHERE email_sent_at IS NOT NULL;
UPDATE interviews SET reminder_status='sent',reminder_error=NULL WHERE reminder_sent_at IS NOT NULL;
COMMIT;
