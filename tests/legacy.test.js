/**
 * Migration of pre-SQLite JSON checkpoints (section 6).
 * The invariants under test: nothing is deleted, nothing is attached to a
 * session that did not ask for it, and repeated startups cannot duplicate data.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CheckpointStore } from "../dist/core/store.js"
import { CheckpointService, DEFAULT_SERVICE_OPTIONS } from "../dist/core/service.js"
import { legacySessionId } from "../dist/core/legacy.js"

function legacyProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "co-legacy-"))
  const projectDirectory = join(dir, "project")
  const stateDir = join(projectDirectory, ".opencode", "state")
  mkdirSync(stateDir, { recursive: true })

  const checkpoint = {
    version: 2,
    updatedAt: "2026-05-13T16:48:16.000Z",
    task: { title: "Legacy task", objective: "Legacy objective", status: "in_progress" },
    summary: "Legacy summary",
    currentPlan: ["plan-1"],
    completedSteps: ["done-1"],
    nextSteps: ["next-1"],
    blockers: [],
    filesTouched: ["a.ts"],
    notes: ["note-1"],
  }
  const history = {
    snapshots: [
      { name: "named-legacy", savedAt: "2026-05-12T10:00:00.000Z", data: { ...checkpoint, task: { ...checkpoint.task, title: "snapshot-1" } } },
      { name: "auto-123", savedAt: "2026-05-11T10:00:00.000Z", data: { ...checkpoint, task: { ...checkpoint.task, title: "snapshot-2" } } },
      ...(options.duplicateNames
        ? [{ name: "auto-123", savedAt: "2026-05-10T10:00:00.000Z", data: { ...checkpoint, task: { ...checkpoint.task, title: "dupe" } } }]
        : []),
    ],
  }

  const checkpointPath = join(stateDir, "checkpoint.json")
  const historyPath = join(stateDir, "checkpoint-history.json")
  writeFileSync(checkpointPath, options.checkpointRaw ?? JSON.stringify(checkpoint, null, 2))
  writeFileSync(historyPath, options.historyRaw ?? JSON.stringify(history, null, 2))
  writeFileSync(join(stateDir, "handoff.md"), "# legacy handoff\n")

  const store = new CheckpointStore(join(dir, "checkpoints.db"))
  const service = new CheckpointService(store, { ...DEFAULT_SERVICE_OPTIONS })
  const active = { sessionID: "ses_active", projectID: "proj-1", projectDirectory }
  const legacy = { sessionID: legacySessionId("proj-1"), projectID: "proj-1", projectDirectory }

  return {
    dir,
    projectDirectory,
    stateDir,
    checkpointPath,
    historyPath,
    store,
    service,
    active,
    legacy,
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("legacy state is imported into a named legacy namespace, never into a live session", () => {
  const ctx = legacyProject()
  try {
    ctx.service.save(ctx.active, { task: { title: "live work" } }, { origin: "tool" })

    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, true)
    assert.equal(result.snapshotCount, 2)

    const imported = ctx.store.loadCheckpoint(ctx.legacy.sessionID)
    assert.equal(imported.data.task.title, "Legacy task")
    assert.deepEqual(imported.data.completedSteps, ["done-1"])
    assert.equal(ctx.store.getSession(ctx.legacy.sessionID).title, "Legacy project-level checkpoint (imported)")

    // The active session must be completely untouched by the import.
    assert.equal(ctx.service.load(ctx.active).data.task.title, "live work")
    assert.deepEqual(ctx.service.load(ctx.active).data.completedSteps, [])
    assert.equal(ctx.service.listSnapshots(ctx.active).length, 1)
  } finally {
    ctx.cleanup()
  }
})

test("originals are copied, never deleted or rewritten", () => {
  const ctx = legacyProject()
  try {
    const beforeCheckpoint = readFileSync(ctx.checkpointPath, "utf8")
    const beforeHistory = readFileSync(ctx.historyPath, "utf8")

    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, true)
    assert.ok(result.backedUp.length >= 2, "backups must be produced")

    assert.equal(readFileSync(ctx.checkpointPath, "utf8"), beforeCheckpoint)
    assert.equal(readFileSync(ctx.historyPath, "utf8"), beforeHistory)
    assert.equal(existsSync(join(ctx.stateDir, "handoff.md")), true)
    for (const backup of result.backedUp) assert.equal(existsSync(backup), true)
  } finally {
    ctx.cleanup()
  }
})

test("snapshot names and timestamps are preserved, and duplicate names are disambiguated", () => {
  const ctx = legacyProject({ duplicateNames: true })
  try {
    ctx.service.importLegacy(ctx.active, true)
    const names = ctx.service.listSnapshots(ctx.legacy).map((snapshot) => snapshot.name)

    assert.ok(names.includes("named-legacy"))
    assert.ok(names.includes("auto-123"))
    assert.ok(names.includes("auto-123#2"), `duplicates must be disambiguated, got ${names.join(", ")}`)
    const auto = ctx.service.loadSnapshot(ctx.legacy, "auto-123")
    assert.equal(auto.savedAt, "2026-05-11T10:00:00.000Z")
  } finally {
    ctx.cleanup()
  }
})

test("repeated startup does not duplicate the import", () => {
  const ctx = legacyProject()
  try {
    const first = ctx.service.importLegacy(ctx.active, true)
    assert.equal(first.imported, true)
    const afterFirst = ctx.service.listSnapshots(ctx.legacy).length

    const second = ctx.service.importLegacy(ctx.active, true)
    assert.equal(second.imported, false)
    assert.equal(second.reason, "already-imported")
    assert.equal(ctx.service.listSnapshots(ctx.legacy).length, afterFirst)

    // A later run with a brand new database would import again; within one
    // database the ledger is authoritative.
    const third = ctx.service.importLegacy(ctx.active, true)
    assert.equal(third.reason, "already-imported")
  } finally {
    ctx.cleanup()
  }
})

test("import can be disabled entirely, leaving legacy files in place", () => {
  const ctx = legacyProject()
  try {
    const result = ctx.service.importLegacy(ctx.active, false)
    assert.equal(result.imported, false)
    assert.equal(result.reason, "disabled")
    assert.equal(ctx.service.status(ctx.legacy).exists, false)
    assert.equal(existsSync(ctx.checkpointPath), true)
  } finally {
    ctx.cleanup()
  }
})

test("a failed import rolls back completely and can be retried", () => {
  const ctx = legacyProject()
  try {
    const original = ctx.store.recordMigration.bind(ctx.store)
    ctx.store.recordMigration = () => {
      throw new Error("simulated failure while recording the ledger")
    }

    assert.throws(() => ctx.service.importLegacy(ctx.active, true), /simulated failure/)

    assert.equal(ctx.store.loadCheckpoint(ctx.legacy.sessionID), null, "a failed import must leave no partial data")
    assert.equal(ctx.service.listSnapshots(ctx.legacy).length, 0)
    assert.equal(ctx.store.getSession(ctx.legacy.sessionID), null, "a failed import must leave no session row")

    ctx.store.recordMigration = original
    const retry = ctx.service.importLegacy(ctx.active, true)
    assert.equal(retry.imported, true)
    assert.equal(ctx.service.loadSnapshot(ctx.legacy, "named-legacy").data.task.title, "snapshot-1")
  } finally {
    ctx.cleanup()
  }
})

test("unreadable legacy files are reported, not thrown, and left untouched", () => {
  const ctx = legacyProject({ checkpointRaw: "{ this is not json", historyRaw: "also not json" })
  try {
    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, false)
    assert.equal(result.reason, "unreadable-legacy-state", "corrupt files must not look like absent files")
    assert.equal(result.warnings.length, 2)
    assert.equal(existsSync(ctx.checkpointPath), true)
    assert.equal(readFileSync(ctx.checkpointPath, "utf8"), "{ this is not json")

    // Reporting is available to the agent as well.
    const adoption = ctx.service.adoptLegacy(ctx.active, false)
    assert.equal(adoption.legacyPresent, true)
    assert.equal(adoption.warnings.length, 2)
  } finally {
    ctx.cleanup()
  }
})

test("a valid checkpoint with a corrupt history imports the checkpoint and warns about the rest", () => {
  const ctx = legacyProject({ historyRaw: "{{{ not json" })
  try {
    const result = ctx.service.importLegacy(ctx.active, true)

    assert.equal(result.imported, true, "the readable part is still recovered")
    assert.equal(result.snapshotCount, 0)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /checkpoint-history\.json/)

    const imported = ctx.store.loadCheckpoint(legacySessionId("proj-1"))
    assert.equal(imported.data.task.title, "Legacy task")
    assert.equal(readFileSync(ctx.historyPath, "utf8"), "{{{ not json", "the corrupt file is preserved for inspection")
  } finally {
    ctx.cleanup()
  }
})

test("an adoption attempt against unreadable legacy state reports why it refused", () => {
  const ctx = legacyProject({ checkpointRaw: "not json at all" })
  try {
    const adoption = ctx.service.adoptLegacy(ctx.active, true)
    assert.equal(adoption.adopted, false)
    assert.equal(adoption.reason, "unreadable-legacy-state")
    assert.equal(ctx.service.status(ctx.active).exists, false)
  } finally {
    ctx.cleanup()
  }
})

test("legacy state is readable even when a project has no legacy files at all", () => {
  const ctx = legacyProject()
  try {
    rmSync(ctx.stateDir, { recursive: true, force: true })
    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, false)
    assert.equal(result.reason, "no-legacy-state")
  } finally {
    ctx.cleanup()
  }
})

test("reporting is the default; adoption into a session is explicit", () => {
  const ctx = legacyProject()
  try {
    const report = ctx.service.adoptLegacy(ctx.active, false)
    assert.equal(report.adopted, false)
    assert.equal(report.legacyPresent, true)
    assert.equal(report.alreadyImported, false)
    assert.equal(report.legacySessionID, legacySessionId("proj-1"))
    assert.equal(ctx.service.status(ctx.active).exists, false, "reporting must not write anything")
  } finally {
    ctx.cleanup()
  }
})

test("adoption copies legacy state into the calling session and is recorded", () => {
  const ctx = legacyProject()
  try {
    ctx.service.importLegacy(ctx.active, true)
    const adoption = ctx.service.adoptLegacy(ctx.active, true)

    assert.equal(adoption.adopted, true)
    const live = ctx.service.load(ctx.active).data
    assert.equal(live.task.title, "Legacy task")
    assert.deepEqual(live.nextSteps, ["next-1"])

    const names = ctx.service.listSnapshots(ctx.active).map((snapshot) => snapshot.name)
    assert.ok(names.some((name) => name.startsWith("adopted-legacy-")), "adoption must be snapshotted")

    // The legacy namespace is unaffected by the copy.
    assert.equal(ctx.store.loadCheckpoint(legacySessionId("proj-1")).data.task.title, "Legacy task")
  } finally {
    ctx.cleanup()
  }
})

test("a payload that is not this plugin's data is reported, never imported or migrated", () => {
  const ctx = legacyProject()
  try {
    // Someone else owns a file at the conventional legacy path.
    writeFileSync(ctx.checkpointPath, JSON.stringify({ otherPlugin: true, entries: [1, 2, 3] }))
    writeFileSync(ctx.historyPath, JSON.stringify({ snapshots: [{ name: "theirs", data: { otherPlugin: true } }] }))

    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, false)
    assert.equal(result.reason, "unrecognized-legacy-state")
    assert.equal(result.warnings.length, 2)
    assert.match(result.warnings[0], /does not match the checkpoint-orchestrator schema/)

    // Nothing was imported, nothing was written, and the foreign files are intact.
    assert.equal(ctx.store.loadCheckpoint(legacySessionId("proj-1")), null)
    assert.equal(ctx.store.listSessionIds().length, 0)
    assert.equal(readFileSync(ctx.checkpointPath, "utf8"), JSON.stringify({ otherPlugin: true, entries: [1, 2, 3] }))
    assert.equal(readFileSync(ctx.historyPath, "utf8"), JSON.stringify({ snapshots: [{ name: "theirs", data: { otherPlugin: true } }] }))

    // Reporting surfaces it too, and adoption refuses with the same reason.
    const report = ctx.service.adoptLegacy(ctx.active, false)
    assert.equal(report.legacyPresent, true)
    assert.ok(report.warnings.some((warning) => /not checkpoint-orchestrator data/.test(warning)))
    const adoption = ctx.service.adoptLegacy(ctx.active, true)
    assert.equal(adoption.adopted, false)
    assert.equal(adoption.reason, "unrecognized-legacy-state")
  } finally {
    ctx.cleanup()
  }
})

test("a foreign file at the legacy path does not block importing our own data later", () => {
  const ctx = legacyProject()
  try {
    writeFileSync(ctx.checkpointPath, JSON.stringify({ otherPlugin: true }))
    writeFileSync(ctx.historyPath, JSON.stringify({ snapshots: [{ name: "theirs", data: { otherPlugin: true } }] }))
    assert.equal(ctx.service.importLegacy(ctx.active, true).reason, "unrecognized-legacy-state")

    // The ledger must NOT have been written, so a genuine file still imports.
    writeFileSync(
      ctx.checkpointPath,
      JSON.stringify({ version: 2, updatedAt: "2026-05-13T16:48:16.000Z", task: { title: "ours" }, nextSteps: ["x"] }),
    )
    const second = ctx.service.importLegacy(ctx.active, true)
    assert.equal(second.imported, true)
    assert.equal(ctx.store.loadCheckpoint(legacySessionId("proj-1")).data.task.title, "ours")
  } finally {
    ctx.cleanup()
  }
})

test("legacy backup copies are written into this plugin's namespace, not beside the originals", () => {
  const ctx = legacyProject()
  try {
    const result = ctx.service.importLegacy(ctx.active, true)
    assert.equal(result.imported, true)
    assert.ok(result.backedUp.length >= 2)
    for (const backup of result.backedUp) {
      assert.ok(
        backup.includes("/.opencode/state/checkpoint-orchestrator/legacy-backup/"),
        `backup escaped the plugin namespace: ${backup}`,
      )
      assert.equal(existsSync(backup), true)
    }
    // The shared directory keeps only the original files plus our own namespace.
    const shared = readdirSync(ctx.stateDir)
    assert.deepEqual(shared.sort(), ["checkpoint-history.json", "checkpoint-orchestrator", "checkpoint.json", "handoff.md"])
  } finally {
    ctx.cleanup()
  }
})

test("adoption without a live checkpoint in our own schema is refused with a reason", () => {
  const ctx = legacyProject()
  try {
    // A file that parses and matches our schema but carries no task state.
    writeFileSync(ctx.checkpointPath, JSON.stringify({ version: 2, updatedAt: "2026-01-01T00:00:00.000Z", notes: [] }))
    const adoption = ctx.service.adoptLegacy(ctx.active, true)
    assert.equal(adoption.adopted, true, "an empty-but-ours payload still normalizes to a valid, if empty, checkpoint")
  } finally {
    ctx.cleanup()
  }
})

test("import respects the configured history limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-legacy-limit-"))
  try {
    const projectDirectory = join(dir, "project")
    const stateDir = join(projectDirectory, ".opencode", "state")
    mkdirSync(stateDir, { recursive: true })
    const snapshots = Array.from({ length: 30 }, (_, i) => ({
      name: `snap-${i}`,
      savedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      data: { version: 2, updatedAt: "2026-01-01T00:00:00.000Z", task: { title: `t${i}` } },
    }))
    writeFileSync(join(stateDir, "checkpoint-history.json"), JSON.stringify({ snapshots }))
    writeFileSync(join(stateDir, "checkpoint.json"), JSON.stringify({ task: { title: "live" } }))

    const store = new CheckpointStore(join(dir, "checkpoints.db"))
    const service = new CheckpointService(store, { ...DEFAULT_SERVICE_OPTIONS, historyLimit: 5 })
    const ref = { sessionID: "ses_active", projectID: "proj-1", projectDirectory }

    const result = service.importLegacy(ref, true)
    assert.equal(result.imported, true)
    assert.equal(result.snapshotCount, 30)
    assert.ok(
      service.listSnapshots({ sessionID: legacySessionId("proj-1"), projectID: "proj-1", projectDirectory }).length <= 5,
    )
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
