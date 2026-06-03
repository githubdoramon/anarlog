CREATE TABLE IF NOT EXISTS meeting_transcript_upload_queue (
  id                TEXT PRIMARY KEY NOT NULL,
  session_id        TEXT NOT NULL DEFAULT '',
  transcript_hash   TEXT NOT NULL DEFAULT '',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL DEFAULT '',
  last_error        TEXT NOT NULL DEFAULT '',
  server_id         TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at           TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_transcript_upload_queue_session_hash
  ON meeting_transcript_upload_queue(session_id, transcript_hash);

CREATE INDEX IF NOT EXISTS idx_meeting_transcript_upload_queue_retry
  ON meeting_transcript_upload_queue(status, next_attempt_at);
