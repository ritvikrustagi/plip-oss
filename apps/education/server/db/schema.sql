-- Plip for school: the production schema.
--
-- Two rules are enforced here rather than only in code:
--   * an event's student is a pseudonymous user id. Names and email addresses
--     live in `users` and nowhere else, so a dump of `events` identifies nobody.
--   * an event may only name a class its session is linked to, and only while
--     the student is sharing. Both are foreign keys plus a CHECK.
--
-- SQLite via node:sqlite. One file, WAL, no server to run. A single school fits
-- in it comfortably; docs/CHROMEBOOK.md says when to move to Postgres and what
-- stays the same when you do.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,           -- pseudonymous: stu_… / tea_…. This is what events carry.
  -- Created by the roster import, before anybody signs in: a class exists as
  -- soon as the school says it does, so a teacher sees the whole roster from
  -- day one and an empty row reads as "no shared work", not as "not a pupil".
  -- Until the first sign-in, issuer is '' and subject is the email address.
  issuer       TEXT NOT NULL,              -- the identity provider that vouched for them
  subject      TEXT NOT NULL,              -- the IdP's own stable id for them
  email_lower  TEXT NOT NULL,              -- how the roster import matches them. Never leaves this table.
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (issuer, subject),
  UNIQUE (email_lower)
);

CREATE TABLE IF NOT EXISTS classes (
  class_id         TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  join_code        TEXT NOT NULL UNIQUE,
  planned_concepts TEXT NOT NULL DEFAULT '[]',   -- JSON array of concept ids
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrolments (
  class_id TEXT NOT NULL REFERENCES classes (class_id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS enrolments_by_user ON enrolments (user_id);

CREATE TABLE IF NOT EXISTS study_sessions (
  session_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  class_id   TEXT REFERENCES classes (class_id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  paused     INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  sharing    INTEGER NOT NULL DEFAULT 0 CHECK (sharing IN (0, 1)),
  active_ms  INTEGER NOT NULL DEFAULT 0,
  consent    TEXT NOT NULL,                 -- JSON: what they agreed to, and when
  -- Sharing without a class is not a state that may exist.
  CHECK (sharing = 0 OR class_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sessions_by_student ON study_sessions (student_id);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES study_sessions (session_id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  class_id    TEXT REFERENCES classes (class_id) ON DELETE SET NULL,
  ts          TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('windows', 'chromebook', 'extension')),
  type        TEXT NOT NULL CHECK (type IN ('session_started', 'task_started', 'hint_requested',
                                            'attempt_submitted', 'task_completed', 'session_ended')),
  task_id     TEXT,
  concept_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array
  evidence    TEXT,                         -- JSON object, or NULL
  share       INTEGER NOT NULL CHECK (share IN (0, 1)),
  -- A teacher-visible event is always attached to a class. The contract says
  -- so; the database refuses the other shape outright.
  CHECK (share = 0 OR class_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS events_by_class ON events (class_id, share, ts);
CREATE INDEX IF NOT EXISTS events_by_student ON events (student_id, ts);
CREATE INDEX IF NOT EXISTS events_by_ts ON events (ts);

CREATE TABLE IF NOT EXISTS auth_sessions (
  sid        TEXT PRIMARY KEY,              -- random; the cookie carries it, signed
  user_id    TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);

-- In flight for the length of one sign-in: the PKCE verifier and the state.
CREATE TABLE IF NOT EXISTS auth_states (
  state      TEXT PRIMARY KEY,
  verifier   TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Who looked at whose work. A teacher dashboard without this is a dashboard
-- nobody can answer for.
CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  actor_user_id   TEXT,
  actor_role      TEXT,
  action          TEXT NOT NULL,
  subject_user_id TEXT,
  class_id        TEXT,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS audit_by_subject ON audit (subject_user_id, at);
CREATE INDEX IF NOT EXISTS audit_by_actor ON audit (actor_user_id, at);
