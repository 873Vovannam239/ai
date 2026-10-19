-- Bản cập nhật an toàn: chỉ thêm bảng và cột, không xóa dữ liệu cũ.
CREATE TABLE IF NOT EXISTS automation_runs (
  id bigserial PRIMARY KEY,
  workflow text NOT NULL,
  ref_id text,
  status text NOT NULL CHECK (status IN ('received','success','failed')),
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_created ON automation_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS candidate_rankings (
  candidate_id uuid PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rank_position integer NOT NULL CHECK(rank_position>0),
  score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_verified_at timestamptz;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_status text NOT NULL DEFAULT 'pending';
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminder_error text;
CREATE INDEX IF NOT EXISTS idx_interview_reminder ON interviews(starts_at,reminder_status) WHERE status='scheduled';
-- Trạng thái 'sending' giúp 2 webhook chạy song song không gửi thư mời hai lần.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_email_status_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_email_status_check CHECK (email_status IN ('pending','sending','sent','failed'));
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS email_attempt_started_at timestamptz;
