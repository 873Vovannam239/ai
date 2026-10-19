CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL, department text NOT NULL DEFAULT 'Chung',
  location text NOT NULL DEFAULT 'Việt Nam',
  description text NOT NULL, requirements text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name text NOT NULL, email text NOT NULL, cv_filename text NOT NULL, cv_text text NOT NULL,
  ai_status text NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending','ready','error')),
  score integer CHECK (score >= 0 AND score <= 100),
  ai_summary text, ai_strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_confidence text, ai_error text, analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidates_job_rank ON candidates(job_id, score DESC NULLS LAST);
CREATE TABLE IF NOT EXISTS interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, duration_minutes integer NOT NULL DEFAULT 30,
  mode text NOT NULL DEFAULT 'online' CHECK (mode IN ('online','onsite')),
  meeting_link text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','failed')),
  email_error text, email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY, category text NOT NULL, message text NOT NULL,
  ref_id text, created_at timestamptz NOT NULL DEFAULT now()
);

-- TalentFlow PRO extension for NEW installations
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
