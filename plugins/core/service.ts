/**
 * Session-scoped checkpoint service: the single place that decides what a save
 * means, when a snapshot is warranted, and what gets injected into a compaction.
 *
 * Every method takes an explicit `SessionRef`, so no call can reach another
 * session's data.
 */
import { existsSync, rmSync } from "node:fs"
import { HANDOFF_DIR, renderHandoff, handoffFilePath, writeHandoffFile } from "./handoff.js"
import {
  importLegacyState,
  legacySessionId,
  migrationLedgerId,
  readLegacyState,
  type ImportResult,
} from "./legacy.js"
import type { CheckpointStore, ClearResult } from "./store.js"
import type { CheckpointData, SessionRef, SnapshotKind, SnapshotRecord, StoredCheckpoint } from "./types.js"
import { autoSnapshotName, contentFingerprint, deepMerge, nowIso } from "./util.js"

export interface ServiceLogger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface ServiceOptions {
  /** Snapshots retained per session. */
  historyLimit: number
  handoffEnabled: boolean
  /** Directory (relative to the project) receiving the per-session handoff file. */
  handoffDirectory: string
  /** Persist every Nth user prompt. 0 disables the periodic trigger. */
  autosaveEvery: number
  maxInjectionChars: number
}

export const DEFAULT_SERVICE_OPTIONS: ServiceOptions = {
  historyLimit: 10,
  handoffEnabled: true,
  handoffDirectory: HANDOFF_DIR,
  autosaveEvery: 5,
  maxInjectionChars: 20_000,
}

export type SaveOrigin = "tool" | "compaction" | "periodic" | "migration"
export type SnapshotPolicy = "changed" | "always" | "never"

export interface SaveOptions {
  origin: SaveOrigin
  synthesized?: boolean
  snapshotName?: string
  snapshotPolicy?: SnapshotPolicy
}

export interface SaveOutcome {
  data: CheckpointData
  changed: boolean
  synthesized: boolean
  snapshotName: string | null
  snapshotKind: SnapshotKind | null
  handoffPath: string | null
}

export interface StatusOutcome {
  exists: boolean
  sessionID: string
  projectID: string
  updatedAt: string | null
  title: string | null
  status: string | null
  completedSteps: number
  nextSteps: number
  blockers: number
  synthesized: boolean
  snapshotCount: number
}

export interface RestoreOutcome {
  restored: boolean
  name: string
  undoSnapshot: string | null
  available?: string[]
  error?: string
}

export interface CompactionOutcome {
  data: CheckpointData | null
  synthesized: boolean
  changed: boolean
  injection: string | null
}

export interface PromptTickOutcome {
  counted: boolean
  saved: boolean
  reason: "below-threshold" | "unchanged" | "changed" | "no-checkpoint" | "disabled"
  counter: number
}

export interface AdoptOutcome {
  adopted: boolean
  reason: string
  legacyPresent: boolean
  alreadyImported: boolean
  legacySessionID: string
  legacySnapshots: number
  availableSnapshots?: string[]
  changed?: boolean
  /** Legacy files that exist but could not be parsed. */
  warnings: string[]
}

export interface DiagnosticsOutcome {
  databasePath: string
  schemaVersion: number
  journalMode: string
  integrity: string
  foreignKeyViolations: number
  historyLimit: number
  sessions: number
}

const SYNTHESIZED_SUMMARY =
  "Session compacted without a prior checkpoint_save call. State synthesized automatically; no task progress was inferred."

export class CheckpointService {
  constructor(
    private readonly store: CheckpointStore,
    private readonly options: ServiceOptions = DEFAULT_SERVICE_OPTIONS,
    private readonly logger: ServiceLogger = silentLogger(),
  ) {}

  get historyLimit(): number {
    return this.options.historyLimit
  }

  get autosaveEvery(): number {
    return this.options.autosaveEvery
  }

  /** Register project/session rows. Idempotent and safe to call on every event. */
  ensure(ref: SessionRef): void {
    this.store.ensureSession(ref)
  }

  load(ref: SessionRef): StoredCheckpoint | null {
    return this.store.loadCheckpoint(ref.sessionID)
  }

  /**
   * Merge, persist, and snapshot. An unchanged payload is *not* written and does
   * not move `updatedAt`, so periodic triggers cannot be mistaken for progress.
   */
  save(ref: SessionRef, incoming: Partial<CheckpointData>, options: SaveOptions): SaveOutcome {
    this.store.ensureSession(ref)

    // Read-merge-write happens inside one transaction so two writers on the same
    // session cannot lose each other's fields.
    const outcome = this.store.transaction((): SaveOutcome & { skipped: boolean } => {      const existing = this.store.loadCheckpoint(ref.sessionID)
      const merged = deepMerge(existing?.data ?? null, incoming)
      const changed = contentFingerprint(merged) !== contentFingerprint(existing?.data ?? null)
      const synthesized = options.synthesized ?? false
      const policy = options.snapshotPolicy ?? "changed"
      const wantsSnapshot = options.snapshotName !== undefined || policy === "always" || (policy === "changed" && changed)

      if (!changed && !wantsSnapshot) {
        return {
          data: existing?.data ?? merged,
          changed: false,
          synthesized: existing?.synthesized ?? false,
          snapshotName: null,
          snapshotKind: null,
          handoffPath: null,
          skipped: true,
        }
      }

      // Only a real content change rewrites the checkpoint row, so `updatedAt`
      // keeps meaning "when the task state last changed" even when the caller
      // asks for a named snapshot of unchanged state.
      if (changed) {
        this.store.saveCheckpoint({
          sessionID: ref.sessionID,
          projectID: ref.projectID,
          data: merged,
          synthesized,
        })
      }

      let storedName: string | null = null
      let storedKind: SnapshotKind | null = null
      if (wantsSnapshot) {
        const snapshotName = options.snapshotName ?? autoSnapshotName(new Date(merged.updatedAt))
        const snapshotKind: SnapshotKind = options.snapshotName ? "named" : "auto"
        this.store.addSnapshot({
          sessionID: ref.sessionID,
          projectID: ref.projectID,
          name: snapshotName,
          kind: snapshotKind,
          data: changed ? merged : (existing?.data ?? merged),
          savedAt: changed ? merged.updatedAt : (existing?.data.updatedAt ?? merged.updatedAt),
        })
        this.store.pruneSnapshots(ref.sessionID, this.options.historyLimit)
        storedName = snapshotName
        storedKind = snapshotKind
      }

      return {
        data: changed ? merged : (existing?.data ?? merged),
        changed,
        synthesized: changed ? synthesized : (existing?.synthesized ?? false),
        snapshotName: storedName,
        snapshotKind: storedKind,
        handoffPath: null,
        skipped: false,
      }
    })

    // File export is deliberately outside the transaction.
    let handoffPath: string | null = null
    if (!outcome.skipped && outcome.changed && this.options.handoffEnabled) {
      handoffPath = this.exportHandoff(ref, outcome.data)
    }

    if (outcome.skipped || !outcome.changed) {
      this.logger.info("Checkpoint save produced no change; nothing recorded", {
        sessionID: ref.sessionID,
        origin: options.origin,
      })
    } else {
      this.logger.info("Checkpoint saved", {
        sessionID: ref.sessionID,
        origin: options.origin,
        snapshot: outcome.snapshotName,
        synthesized: outcome.synthesized,
      })
    }

    const { skipped: _skipped, ...result } = outcome
    void _skipped
    return { ...result, handoffPath }
  }

  status(ref: SessionRef): StatusOutcome {
    const stored = this.store.loadCheckpoint(ref.sessionID)
    const snapshotCount = this.store.countSnapshots(ref.sessionID)
    if (!stored) {
      return {
        exists: false,
        sessionID: ref.sessionID,
        projectID: ref.projectID,
        updatedAt: null,
        title: null,
        status: null,
        completedSteps: 0,
        nextSteps: 0,
        blockers: 0,
        synthesized: false,
        snapshotCount,
      }
    }
    return {
      exists: true,
      sessionID: ref.sessionID,
      projectID: ref.projectID,
      updatedAt: stored.data.updatedAt,
      title: stored.data.task?.title ?? null,
      status: stored.data.task?.status ?? null,
      completedSteps: stored.data.completedSteps?.length ?? 0,
      nextSteps: stored.data.nextSteps?.length ?? 0,
      blockers: stored.data.blockers?.length ?? 0,
      synthesized: stored.synthesized,
      snapshotCount,
    }
  }

  /** Clear only this session's live state, snapshots and counters. */
  clear(ref: SessionRef): ClearResult & { handoffRemoved: boolean } {
    const result = this.store.transaction(() => this.store.clearSession(ref.sessionID))
    let handoffRemoved = false
    if (this.options.handoffEnabled) {
      const path = handoffFilePath(ref.projectDirectory, ref.sessionID, this.options.handoffDirectory)
      try {
        if (existsSync(path)) {
          rmSync(path)
          handoffRemoved = true
        }
      } catch (error) {
        this.logger.warn("Failed to remove handoff file", { error: String(error) })
      }
    }
    return { ...result, handoffRemoved }
  }

  listSnapshots(ref: SessionRef, limit?: number): SnapshotRecord[] {
    return this.store.listSnapshots(ref.sessionID, limit)
  }

  loadSnapshot(ref: SessionRef, name: string): SnapshotRecord | null {
    return this.store.getSnapshot(ref.sessionID, name)
  }

  /**
   * Promote a snapshot to live state. The current live state is first captured
   * as a `pre-restore` snapshot, and pruning is guaranteed to retain it, so an
   * undo point is always available afterwards.
   */
  restoreSnapshot(ref: SessionRef, name: string): RestoreOutcome {
    return this.store.transaction(() => {
      const target = this.store.getSnapshot(ref.sessionID, name)
      if (!target) {
        return {
          restored: false,
          name,
          undoSnapshot: null,
          error: "Snapshot not found",
          available: this.store.listSnapshots(ref.sessionID).map((snapshot) => snapshot.name),
        }
      }

      const live = this.store.loadCheckpoint(ref.sessionID)
      let undoSnapshot: string | null = null
      if (live) {
        undoSnapshot = `pre-restore-${Date.now()}`
        this.store.addSnapshot({
          sessionID: ref.sessionID,
          projectID: ref.projectID,
          name: undoSnapshot,
          kind: "pre-restore",
          data: live.data,
          savedAt: nowIso(),
        })
      }

      const restored: CheckpointData = { ...target.data, updatedAt: nowIso() }
      this.store.saveCheckpoint({
        sessionID: ref.sessionID,
        projectID: ref.projectID,
        data: restored,
        synthesized: false,
      })
      this.store.markSnapshotRestored(ref.sessionID, name)
      this.store.pruneSnapshots(ref.sessionID, this.options.historyLimit)

      if (this.options.handoffEnabled) this.exportHandoff(ref, restored)

      this.logger.info("Snapshot restored", { sessionID: ref.sessionID, name, undoSnapshot })
      return { restored: true, name, undoSnapshot }
    })
  }

  /**
   * Trigger A (context compaction). Persists the session's own state and returns
   * the text to inject into the compaction request. Synthesized placeholders are
   * never injected: they contain no real task progress.
   */
  handleCompaction(ref: SessionRef, options: { synthesize: boolean }): CompactionOutcome {
    this.store.ensureSession(ref)
    const existing = this.store.loadCheckpoint(ref.sessionID)

    if (existing) {
      const outcome = this.save(ref, {}, { origin: "compaction", snapshotPolicy: "changed" })
      return {
        data: outcome.data,
        synthesized: outcome.synthesized,
        changed: outcome.changed,
        injection: existing.synthesized ? null : this.buildInjection(ref, outcome.data),
      }
    }

    if (!options.synthesize) {
      return { data: null, synthesized: false, changed: false, injection: null }
    }

    const outcome = this.save(
      ref,
      {
        task: { title: "Auto-synthesized checkpoint", status: "in_progress" },
        summary: SYNTHESIZED_SUMMARY,
        notes: ["Auto-generated on context compaction: the agent did not call checkpoint_save first."],
      },
      { origin: "compaction", synthesized: true, snapshotPolicy: "never" },
    )
    this.logger.warn("Synthesized placeholder checkpoint on compaction", { sessionID: ref.sessionID })
    return { data: outcome.data, synthesized: true, changed: outcome.changed, injection: null }
  }

  /**
   * Deduplicated injection text for the given state. Returns null when the same
   * content was already injected for this session.
   */
  buildInjection(ref: SessionRef, data: CheckpointData | null): string | null {
    if (!data) return null
    const hash = contentFingerprint(data)
    // Read-and-record is one transaction so two processes cannot both decide to
    // inject the same state.
    const alreadyInjected = this.store.transaction(() => {
      const runtime = this.store.getRuntime(ref.sessionID)
      if (hash.length > 0 && hash === runtime.lastInjectedHash) return true
      this.store.setRuntime(ref.sessionID, ref.projectID, { lastInjectedHash: hash })
      return false
    })
    if (alreadyInjected) return null
    return renderInjection(data, this.options.maxInjectionChars)
  }

  /** Trigger B (periodic). Counter is per session and persisted. */
  tickPrompt(ref: SessionRef): PromptTickOutcome {
    this.store.ensureSession(ref)
    const limit = this.options.autosaveEvery
    if (limit <= 0) {
      return { counted: false, saved: false, reason: "disabled", counter: 0 }
    }

    // The counter is incremented inside a transaction so concurrent prompt hooks
    // cannot drop an increment.
    const tick = this.store.transaction(() => {
      const runtime = this.store.getRuntime(ref.sessionID)
      const counter = runtime.messagesSinceSave + 1
      if (counter < limit) {
        this.store.setRuntime(ref.sessionID, ref.projectID, { messagesSinceSave: counter })
        return { fired: false, counter }
      }
      this.store.setRuntime(ref.sessionID, ref.projectID, { messagesSinceSave: 0, lastAutosaveAt: nowIso() })
      return { fired: true, counter: 0 }
    })

    if (!tick.fired) {
      return { counted: true, saved: false, reason: "below-threshold", counter: tick.counter }
    }

    const existing = this.store.loadCheckpoint(ref.sessionID)
    if (!existing) {
      return { counted: true, saved: false, reason: "no-checkpoint", counter: 0 }
    }
    const outcome = this.save(ref, {}, { origin: "periodic", snapshotPolicy: "changed" })
    return {
      counted: true,
      saved: outcome.changed,
      reason: outcome.changed ? "changed" : "unchanged",
      counter: 0,
    }
  }

  /** Explicit, opt-in adoption of legacy state into the caller's session. */
  adoptLegacy(ref: SessionRef, adopt: boolean): AdoptOutcome {
    const legacySessionID = legacySessionId(ref.projectID)
    const state = readLegacyState(ref.projectDirectory)
    const alreadyImported = this.store.hasMigration(migrationLedgerId(ref.projectID))

    const base: AdoptOutcome = {
      adopted: false,
      reason: "reported",
      legacyPresent: state.present,
      alreadyImported,
      legacySessionID,
      legacySnapshots: state.snapshots.length,
      warnings: [
        ...state.unreadable,
        ...state.foreign.map((file) => `${file} is not checkpoint-orchestrator data; left untouched`),
      ],
    }

    if (!adopt) {
      const available = this.store
        .listSnapshots(legacySessionID)
        .map((snapshot) => snapshot.name)
      return { ...base, availableSnapshots: available }
    }

    if (!state.checkpoint) {
      return {
        ...base,
        reason: !state.present
          ? "no-legacy-state"
          : state.unreadable.length > 0
            ? "unreadable-legacy-state"
            : state.foreign.length > 0
              ? "unrecognized-legacy-state"
              : "legacy-state-has-no-live-checkpoint",
      }
    }

    const outcome = this.save(ref, state.checkpoint, {
      origin: "migration",
      snapshotName: `adopted-legacy-${Date.now()}`,
      snapshotPolicy: "always",
    })
    this.store.recordMigration(`legacy-adopt:${ref.sessionID}`, ref.projectID, {
      adoptedFrom: ref.projectDirectory,
    })
    return { ...base, adopted: true, reason: "adopted", changed: outcome.changed }
  }

  /** Import the legacy JSON namespace for a project. Idempotent. */
  importLegacy(ref: SessionRef, enabled: boolean): ImportResult {
    return importLegacyState(this.store, {
      projectID: ref.projectID,
      projectDirectory: ref.projectDirectory,
      historyLimit: this.options.historyLimit,
      enabled,
    })
  }

  /** Write the derived handoff file for a session. Returns the path, or null. */
  exportHandoff(ref: SessionRef, data?: CheckpointData): string | null {
    const state = data ?? this.store.loadCheckpoint(ref.sessionID)?.data
    if (!state) return null
    const path = handoffFilePath(ref.projectDirectory, ref.sessionID, this.options.handoffDirectory)
    try {
      writeHandoffFile(path, renderHandoff(state, ref.sessionID))
      return path
    } catch (error) {
      this.logger.warn("Failed to write handoff file", { path, error: String(error) })
      return null
    }
  }

  diagnostics(): DiagnosticsOutcome {
    return {
      databasePath: this.store.path,
      schemaVersion: this.store.schemaVersion,
      journalMode: this.store.journalModeInUse,
      integrity: this.store.integrityCheck(),
      foreignKeyViolations: this.store.foreignKeyCheck(),
      historyLimit: this.options.historyLimit,
      sessions: this.store.listSessionIds().length,
    }
  }
}

export function renderInjection(data: CheckpointData, maxChars: number): string {
  const payload = JSON.stringify(data, null, 2)
  const body = payload.length > maxChars ? `${payload.slice(0, maxChars)}\n… (truncated)` : payload
  return `## CHECKPOINT STATE

\`\`\`json
${body}
\`\`\`

Continue from this state.
Do not redo completed work.
Prioritize nextSteps.
`
}

function silentLogger(): ServiceLogger {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop }
}
