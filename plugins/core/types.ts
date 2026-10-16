/**
 * Shared data types for Checkpoint Orchestrator.
 *
 * This module intentionally has no dependency on the OpenCode SDK so that it can
 * be unit-tested and imported by any runtime.
 */

/** Version of the serialized checkpoint payload (`CheckpointData.version`). */
export const PAYLOAD_SCHEMA_VERSION = 3

/**
 * Version of the SQLite schema, tracked in `PRAGMA user_version`.
 * `LATEST_SCHEMA_VERSION` in `schema.ts` is derived from the migration list and
 * is authoritative; a unit test asserts the two agree so they cannot drift.
 */
export const DB_SCHEMA_VERSION = 2

export const STATUSES = ["not_started", "in_progress", "blocked", "done"] as const

export type CheckpointStatus = (typeof STATUSES)[number]

export interface TaskState {
  title?: string
  objective?: string
  status?: CheckpointStatus
}

/**
 * The task-continuity payload. Persisted as the authoritative per-session state
 * and exported to JSON for portability.
 */
export interface CheckpointData {
  version: number
  updatedAt: string
  task?: TaskState
  summary?: string
  currentPlan?: string[]
  completedSteps?: string[]
  nextSteps?: string[]
  blockers?: string[]
  filesTouched?: string[]
  notes?: string[]
}

/** How a snapshot came to exist. */
export type SnapshotKind = "auto" | "named" | "pre-restore" | "legacy" | "adopted"

/** A persisted snapshot row. */
export interface SnapshotRecord {
  id: number
  name: string
  kind: SnapshotKind
  savedAt: string
  schemaVersion: number
  restoredAt: string | null
  data: CheckpointData
}

/** A stored checkpoint plus storage-level metadata. */
export interface StoredCheckpoint {
  data: CheckpointData
  synthesized: boolean
  createdAt: string
  updatedAt: string
}

/** Identity of the OpenCode session and project a checkpoint belongs to. */
export interface SessionRef {
  sessionID: string
  projectID: string
  /** Best-effort canonical project directory; used for handoff export and legacy import. */
  projectDirectory: string
  parentID?: string
  title?: string
}

/** Per-session runtime state that must survive plugin reloads. */
export interface SessionRuntime {
  messagesSinceSave: number
  lastInjectedHash: string
  lastAutosaveAt: string | null
}

export function emptyRuntime(): SessionRuntime {
  return { messagesSinceSave: 0, lastInjectedHash: "", lastAutosaveAt: null }
}
