/**
 * SQLite schema definition and forward-only migrations.
 *
 * Versioning uses `PRAGMA user_version`. Every migration is additive and runs in
 * a transaction, so a failed migration leaves the previous version intact.
 */

export interface Migration {
  version: number
  statements: string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE projects (
         id          TEXT PRIMARY KEY,
         directory   TEXT NOT NULL,
         canonical   TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX idx_projects_directory ON projects(directory)`,

      `CREATE TABLE sessions (
         id          TEXT PRIMARY KEY,
         project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         parent_id   TEXT,
         title       TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
      `CREATE INDEX idx_sessions_project ON sessions(project_id)`,
      `CREATE INDEX idx_sessions_parent ON sessions(parent_id)`,
      // Lets child tables reference the (session, project) pair, so a checkpoint
      // can never claim a project its session does not belong to.
      `CREATE UNIQUE INDEX idx_sessions_id_project ON sessions(id, project_id)`,

      `CREATE TABLE checkpoints (
         session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         project_id      TEXT NOT NULL,
         title           TEXT,
         objective       TEXT,
         status          TEXT,
         summary         TEXT,
         current_plan    TEXT NOT NULL DEFAULT '[]',
         completed_steps TEXT NOT NULL DEFAULT '[]',
         next_steps      TEXT NOT NULL DEFAULT '[]',
         blockers        TEXT NOT NULL DEFAULT '[]',
         files_touched   TEXT NOT NULL DEFAULT '[]',
         notes           TEXT NOT NULL DEFAULT '[]',
         schema_version  INTEGER NOT NULL,
         synthesized     INTEGER NOT NULL DEFAULT 0,
         created_at      TEXT NOT NULL,
         updated_at      TEXT NOT NULL,
         FOREIGN KEY (session_id, project_id) REFERENCES sessions(id, project_id)
           ON DELETE CASCADE ON UPDATE CASCADE
       )`,
      `CREATE INDEX idx_checkpoints_project ON checkpoints(project_id)`,

      `CREATE TABLE snapshots (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id     TEXT NOT NULL,
         project_id     TEXT NOT NULL,
         name           TEXT NOT NULL,
         kind           TEXT NOT NULL,
         captured_at    TEXT NOT NULL,
         payload        TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         restored_at    TEXT,
         FOREIGN KEY (session_id, project_id) REFERENCES sessions(id, project_id)
           ON DELETE CASCADE ON UPDATE CASCADE
       )`,
      `CREATE UNIQUE INDEX idx_snapshots_session_name ON snapshots(session_id, name)`,
      `CREATE INDEX idx_snapshots_session_time ON snapshots(session_id, captured_at DESC, id DESC)`,

      `CREATE TABLE session_runtime (
         session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         messages_since_save INTEGER NOT NULL DEFAULT 0,
         last_injected_hash  TEXT NOT NULL DEFAULT '',
         last_autosave_at    TEXT,
         updated_at          TEXT NOT NULL
       )`,

      `CREATE TABLE migrations (
         id         TEXT PRIMARY KEY,
         project_id TEXT,
         applied_at TEXT NOT NULL,
         details    TEXT
       )`,
    ],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/** Statements applied to every connection regardless of schema version. */
export const CONNECTION_PRAGMAS: readonly string[] = [
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = NORMAL",
]
