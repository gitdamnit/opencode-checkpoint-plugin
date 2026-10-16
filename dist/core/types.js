/**
 * Shared data types for Checkpoint Orchestrator.
 *
 * This module intentionally has no dependency on the OpenCode SDK so that it can
 * be unit-tested and imported by any runtime.
 */
/** Version of the serialized checkpoint payload (`CheckpointData.version`). */
export const PAYLOAD_SCHEMA_VERSION = 3;
/**
 * Version of the SQLite schema, tracked in `PRAGMA user_version`.
 * `LATEST_SCHEMA_VERSION` in `schema.ts` is derived from the migration list and
 * is authoritative; a unit test asserts the two agree so they cannot drift.
 */
export const DB_SCHEMA_VERSION = 2;
export const STATUSES = ["not_started", "in_progress", "blocked", "done"];
export function emptyRuntime() {
    return { messagesSinceSave: 0, lastInjectedHash: "", lastAutosaveAt: null };
}
