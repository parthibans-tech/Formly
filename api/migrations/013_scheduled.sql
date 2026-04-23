-- Scheduled generation jobs. The worker polls this table every minute and
-- enqueues an async generate task when `next_run_at <= now()`.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,         -- 5- or 6-field cron expression (robfig/cron)
  timezone TEXT NOT NULL DEFAULT 'UTC',
  data JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
  ON scheduled_jobs(next_run_at)
  WHERE active = true AND next_run_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_jobs_template_idx
  ON scheduled_jobs(template_id);

CREATE TABLE IF NOT EXISTS scheduled_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  output_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  status TEXT NOT NULL,            -- running | completed | failed
  error TEXT,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scheduled_runs_job_idx
  ON scheduled_runs(schedule_id, fired_at DESC);
