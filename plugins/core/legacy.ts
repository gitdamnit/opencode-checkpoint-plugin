/**
 * Migration of the pre-SQLite project-level JSON checkpoints.
 *
 * Guarantees:
 *  - originals are copied, never deleted or rewritten;
 *  - imports run in a single transaction, so a failure can be retried;
 *  - a ledger row makes the import idempotent across restarts;
 *  - legacy data is never attached to an arbitrary active session. It lands in
 *    an explicitly named `legacy::<projectID>` namespace, and moving it into a
 *    real session is an explicit, opt-in operation.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PLUGIN_STATE_DIR } from "./handoff.js"
import type { CheckpointStore } from "./store.js"
import type { CheckpointData, SnapshotKind } from "./types.js"
import { normalizeData, nowIso } from "./util.js"

export const LEGACY_STATE_DIR = ".opencode/state"
export const LEGACY_CHECKPOINT_FILE = "checkpoint.json"
export const LEGACY_HISTORY_FILE = "checkpoint-history.json"
export const LEGACY_HANDOFF_FILE = "handoff.md"

/**
 * Copies of migrated files are written into this plugin's own namespace rather
 * than beside the originals, which may live in a directory shared with other
 * plugins.
 */
export const LEGACY_BACKUP_DIR = `${PLUGIN_STATE_DIR}/legacy-backup`

/** Fields that identify a payload as belonging to this plugin. */
const ORCHESTRATOR_FIELDS = [
  "task",
  "summary",
  "currentPlan",
  "completedSteps",
  "nextSteps",
  "blockers",
  "filesTouched",
  "notes",
] as const

/**
 * Legacy files live at a conventional path in a directory that other tools and
 * plugins may also use. Only payloads that actually match this plugin's schema
 * are imported; anything else is reported and left alone, so a same-named file
 * owned by someone else can never be consumed or overwritten by this plugin.
 */
export function looksLikeOrchestratorPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const hasVersion = typeof record.version === "number" && Number.isFinite(record.version)
  const hasTimestamp = typeof record.updatedAt === "string"
  if (!hasVersion && !hasTimestamp) return false
  if (record.task !== undefined && (typeof record.task !== "object" || record.task === null)) return false
  return ORCHESTRATOR_FIELDS.some((field) => record[field] !== undefined)
}

export interface LegacySnapshot {
  name: string
  savedAt: string
  data: CheckpointData
}

export interface LegacyState {
  /** True when legacy files exist on disk, even if some of them are unreadable. */
  present: boolean
  checkpoint: CheckpointData | null
  snapshots: LegacySnapshot[]
  /** Raw byte length of the legacy checkpoint file, for reporting. */
  checkpointBytes: number
  /** Files that exist but could not be parsed. Never silently ignored. */
  unreadable: string[]
  /** Files that parse but are not this plugin's data. Reported, never imported. */
  foreign: string[]
}

export interface ImportResult {
  imported: boolean
  reason:
    | "imported"
    | "already-imported"
    | "no-legacy-state"
    | "empty-legacy-state"
    | "unreadable-legacy-state"
    | "unrecognized-legacy-state"
    | "disabled"
  snapshotCount: number
  backedUp: string[]
  warnings: string[]
}

export function legacySessionId(projectID: string): string {
  return `legacy::${projectID}`
}

export function migrationLedgerId(projectID: string): string {
  return `legacy-json:${projectID}`
}

export function legacyStateDir(projectDirectory: string): string {
  return join(projectDirectory, LEGACY_STATE_DIR)
}

type JsonRead = { kind: "missing" | "ok" | "error"; value: unknown; error?: string }

function readJsonFile(path: string): JsonRead {
  if (!existsSync(path)) return { kind: "missing", value: null }
  try {
    return { kind: "ok", value: JSON.parse(readFileSync(path, "utf8")) }
  } catch (error) {
    return { kind: "error", value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readLegacyState(projectDirectory: string): LegacyState {
  const dir = legacyStateDir(projectDirectory)
  const checkpointPath = join(dir, LEGACY_CHECKPOINT_FILE)
  const historyPath = join(dir, LEGACY_HISTORY_FILE)

  const checkpointRead = readJsonFile(checkpointPath)
  const historyRead = readJsonFile(historyPath)

  const unreadable: string[] = []
  if (checkpointRead.kind === "error") unreadable.push(`${LEGACY_CHECKPOINT_FILE}: ${checkpointRead.error}`)
  if (historyRead.kind === "error") unreadable.push(`${LEGACY_HISTORY_FILE}: ${historyRead.error}`)

  const foreign: string[] = []
  const checkpointLooksOurs = checkpointRead.kind === "ok" && looksLikeOrchestratorPayload(checkpointRead.value)
  if (checkpointRead.kind === "ok" && !checkpointLooksOurs) foreign.push(LEGACY_CHECKPOINT_FILE)
  const checkpoint = checkpointLooksOurs ? normalizeData(checkpointRead.value) : null

  const snapshots: LegacySnapshot[] = []
  let historyEntriesSeen = 0
  let historyEntriesOurs = 0
  if (historyRead.kind === "ok") {
    const rawSnapshots = (historyRead.value as { snapshots?: unknown } | null)?.snapshots
    if (Array.isArray(rawSnapshots)) {
      for (const entry of rawSnapshots) {
        if (typeof entry !== "object" || entry === null) continue
        const record = entry as { name?: unknown; savedAt?: unknown; data?: unknown }
        if (record.data === undefined) continue
        historyEntriesSeen++
        if (!looksLikeOrchestratorPayload(record.data)) continue
        historyEntriesOurs++
        const name =
          typeof record.name === "string" && record.name.length > 0 ? record.name : `legacy-${snapshots.length + 1}`
        const savedAt = typeof record.savedAt === "string" && record.savedAt.length > 0 ? record.savedAt : nowIso()
        snapshots.push({ name, savedAt, data: normalizeData(record.data) })
      }
    }
    if (historyRead.kind === "ok" && historyEntriesSeen > 0 && historyEntriesOurs === 0) {
      foreign.push(LEGACY_HISTORY_FILE)
    }
  }

  let checkpointBytes = 0
  if (existsSync(checkpointPath)) {
    try {
      checkpointBytes = Buffer.byteLength(readFileSync(checkpointPath, "utf8"))
    } catch {
      checkpointBytes = 0
    }
  }

  const present = checkpointRead.kind !== "missing" || historyRead.kind !== "missing"
  return { present, checkpoint, snapshots, checkpointBytes, unreadable, foreign }
}

/**
 * Copy the legacy artefacts aside. Originals are left untouched, and the copies
 * go into this plugin's namespace so a shared `.opencode/state/` directory is
 * never polluted with our bookkeeping.
 */
export function backupLegacyFiles(projectDirectory: string, stamp: string): string[] {
  const sourceDir = legacyStateDir(projectDirectory)
  const backupDir = join(projectDirectory, LEGACY_BACKUP_DIR)
  const created: string[] = []
  for (const name of [LEGACY_CHECKPOINT_FILE, LEGACY_HISTORY_FILE, LEGACY_HANDOFF_FILE]) {
    const source = join(sourceDir, name)
    if (!existsSync(source)) continue
    const target = join(backupDir, `${name}.${stamp}`)
    try {
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(source, target)
      created.push(target)
    } catch {
      /* backups are best effort; the import itself is still transactional */
    }
  }
  return created
}

export interface ImportLegacyOptions {
  projectID: string
  projectDirectory: string
  historyLimit: number
  /** Set to false to disable automatic import entirely. */
  enabled?: boolean
  stamp?: string
}

export function importLegacyState(store: CheckpointStore, options: ImportLegacyOptions): ImportResult {
  if (options.enabled === false) {
    return { imported: false, reason: "disabled", snapshotCount: 0, backedUp: [], warnings: [] }
  }

  const ledgerId = migrationLedgerId(options.projectID)
  if (store.hasMigration(ledgerId)) {
    return { imported: false, reason: "already-imported", snapshotCount: 0, backedUp: [], warnings: [] }
  }

  const state = readLegacyState(options.projectDirectory)
  if (!state.present) {
    return { imported: false, reason: "no-legacy-state", snapshotCount: 0, backedUp: [], warnings: [] }
  }

  const foreignWarnings = state.foreign.map(
    (file) => `${file} exists but does not match the checkpoint-orchestrator schema; left untouched`,
  )

  if (!state.checkpoint && state.snapshots.length === 0) {
    // Files exist but nothing usable was in them. Report rather than pretend the
    // project never had legacy state.
    const reason = state.unreadable.length > 0
      ? "unreadable-legacy-state"
      : state.foreign.length > 0
        ? "unrecognized-legacy-state"
        : "empty-legacy-state"
    return {
      imported: false,
      reason,
      snapshotCount: 0,
      backedUp: [],
      warnings: [...state.unreadable, ...foreignWarnings],
    }
  }

  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, "-")
  const backedUp = backupLegacyFiles(options.projectDirectory, stamp)

  const sessionID = legacySessionId(options.projectID)
  const ref = {
    sessionID,
    projectID: options.projectID,
    projectDirectory: options.projectDirectory,
    title: "Legacy project-level checkpoint (imported)",
  }

  store.transaction(() => {
    store.ensureSession(ref)
    if (state.checkpoint) {
      store.saveCheckpoint({
        sessionID,
        projectID: options.projectID,
        data: state.checkpoint,
        synthesized: false,
      })
      store.addSnapshot({
        sessionID,
        projectID: options.projectID,
        name: `legacy-live-${stamp}`,
        kind: "legacy" as SnapshotKind,
        data: state.checkpoint,
        savedAt: state.checkpoint.updatedAt,
      })
    }
    const seen = new Set<string>()
    for (const snapshot of state.snapshots) {
      let name = snapshot.name
      let suffix = 2
      while (seen.has(name)) name = `${snapshot.name}#${suffix++}`
      seen.add(name)
      store.addSnapshot({
        sessionID,
        projectID: options.projectID,
        name,
        kind: "legacy" as SnapshotKind,
        data: snapshot.data,
        savedAt: snapshot.savedAt,
      })
    }
    store.pruneSnapshots(sessionID, options.historyLimit)
    store.recordMigration(ledgerId, options.projectID, {
      source: options.projectDirectory,
      snapshots: state.snapshots.length,
      backedUp,
      warnings: [...state.unreadable, ...foreignWarnings],
    })
  })

  return {
    imported: true,
    reason: "imported",
    snapshotCount: state.snapshots.length,
    backedUp,
    warnings: [...state.unreadable, ...foreignWarnings],
  }
}
