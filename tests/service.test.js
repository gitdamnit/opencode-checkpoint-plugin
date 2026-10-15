import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CheckpointStore } from "../dist/core/store.js"
import { CheckpointService, DEFAULT_SERVICE_OPTIONS } from "../dist/core/service.js"
import { handoffFilePath } from "../dist/core/handoff.js"

function setup(serviceOptions = {}, storeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "co-svc-"))
  const projectDir = join(dir, "project")
  const dbPath = join(dir, "checkpoints.db")
  const store = new CheckpointStore(dbPath, storeOptions)
  const service = new CheckpointService(store, { ...DEFAULT_SERVICE_OPTIONS, ...serviceOptions })
  const ref = { sessionID: "ses_one", projectID: "proj-1", projectDirectory: projectDir }
  return {
    dir,
    projectDir,
    store,
    service,
    ref,
    other: { sessionID: "ses_two", projectID: "proj-1", projectDirectory: projectDir },
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("save persists state, snapshots it, and writes a session-scoped handoff", () => {
  const ctx = setup()
  try {
    const outcome = ctx.service.save(
      ctx.ref,
      { task: { title: "Ship it", objective: "Objective", status: "in_progress" }, nextSteps: ["a"] },
      { origin: "tool" },
    )

    assert.equal(outcome.changed, true)
    assert.equal(outcome.snapshotName !== null, true)
    assert.equal(outcome.snapshotKind, "auto")

    const stored = ctx.service.load(ctx.ref)
    assert.equal(stored.data.task.title, "Ship it")
    assert.deepEqual(stored.data.nextSteps, ["a"])
    assert.equal(stored.synthesized, false)

    const handoff = handoffFilePath(ctx.projectDir, ctx.ref.sessionID)
    assert.ok(existsSync(handoff))
    assert.ok(readFileSync(handoff, "utf8").includes("Ship it"))
  } finally {
    ctx.cleanup()
  }
})

test("an unchanged save is a no-op: no snapshot, no updatedAt move, no rewrite", () => {
  const ctx = setup()
  try {
    const first = ctx.service.save(ctx.ref, { task: { title: "T" }, completedSteps: ["one"] }, { origin: "tool" })
    const before = ctx.service.load(ctx.ref)

    const second = ctx.service.save(ctx.ref, {}, { origin: "periodic" })

    assert.equal(second.changed, false)
    assert.equal(second.snapshotName, null)
    assert.equal(second.handoffPath, null)
    assert.equal(ctx.service.load(ctx.ref).data.updatedAt, before.data.updatedAt)
    assert.equal(ctx.service.listSnapshots(ctx.ref).length, 1)
    assert.equal(first.changed, true)
  } finally {
    ctx.cleanup()
  }
})

test("partial updates never clobber stored fields", () => {
  const ctx = setup()
  try {
    ctx.service.save(
      ctx.ref,
      { task: { title: "T", objective: "O" }, summary: "s", completedSteps: ["c"], notes: ["n"] },
      { origin: "tool" },
    )
    ctx.service.save(ctx.ref, { task: { status: "blocked" } }, { origin: "tool" })

    const stored = ctx.service.load(ctx.ref).data
    assert.equal(stored.task.title, "T")
    assert.equal(stored.task.objective, "O")
    assert.equal(stored.task.status, "blocked")
    assert.equal(stored.summary, "s")
    assert.deepEqual(stored.completedSteps, ["c"])
    assert.deepEqual(stored.notes, ["n"])
  } finally {
    ctx.cleanup()
  }
})

test("an explicitly named snapshot is recorded as a named snapshot", () => {
  const ctx = setup()
  try {
    const outcome = ctx.service.save(ctx.ref, { task: { title: "T" } }, { origin: "tool", snapshotName: "checkpoint-alpha" })
    assert.equal(outcome.snapshotName, "checkpoint-alpha")
    assert.equal(outcome.snapshotKind, "named")
    const names = ctx.service.listSnapshots(ctx.ref).map((snapshot) => snapshot.name)
    assert.ok(names.includes("checkpoint-alpha"))
  } finally {
    ctx.cleanup()
  }
})

test("restore creates an undo point and promotes the snapshot atomically", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "v1" }, completedSteps: ["one"] }, { origin: "tool", snapshotName: "v1" })
    ctx.service.save(ctx.ref, { task: { title: "v2" }, completedSteps: ["one", "two"] }, { origin: "tool" })

    const restore = ctx.service.restoreSnapshot(ctx.ref, "v1")
    assert.equal(restore.restored, true)
    assert.ok(restore.undoSnapshot?.startsWith("pre-restore-"))

    const live = ctx.service.load(ctx.ref).data
    assert.equal(live.task.title, "v1")
    assert.deepEqual(live.completedSteps, ["one"])

    const undo = ctx.service.loadSnapshot(ctx.ref, restore.undoSnapshot)
    assert.equal(undo.data.task.title, "v2", "undo must hold the state that was live before restore")
    assert.equal(ctx.service.loadSnapshot(ctx.ref, "v1").restoredAt !== null, true)
  } finally {
    ctx.cleanup()
  }
})

test("the undo point survives later pruning, so a restore is always reversible", () => {
  const ctx = setup({ historyLimit: 2 })
  try {
    ctx.service.save(ctx.ref, { task: { title: "v1" } }, { origin: "tool", snapshotName: "v1" })
    ctx.service.save(ctx.ref, { task: { title: "v2" } }, { origin: "tool" })
    const restore = ctx.service.restoreSnapshot(ctx.ref, "v1")
    const undoName = restore.undoSnapshot

    // Push a lot of new snapshots through the ring buffer.
    for (let i = 0; i < 6; i++) {
      ctx.service.save(ctx.ref, { nextSteps: [`s${i}`] }, { origin: "tool" })
    }

    const undo = ctx.service.loadSnapshot(ctx.ref, undoName)
    assert.ok(undo, "the only undo snapshot must not be pruned away")

    const redo = ctx.service.restoreSnapshot(ctx.ref, undoName)
    assert.equal(redo.restored, true)
    assert.equal(ctx.service.load(ctx.ref).data.task.title, "v2")
  } finally {
    ctx.cleanup()
  }
})

test("restoring an unknown snapshot reports what is available and changes nothing", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "T" } }, { origin: "tool", snapshotName: "known" })
    const result = ctx.service.restoreSnapshot(ctx.ref, "nope")
    assert.equal(result.restored, false)
    assert.equal(result.error, "Snapshot not found")
    assert.deepEqual(result.available, ["known"])
    assert.equal(ctx.service.load(ctx.ref).data.task.title, "T")
  } finally {
    ctx.cleanup()
  }
})

test("periodic trigger counts per session and never invents progress", () => {
  const ctx = setup({ autosaveEvery: 3 })
  try {
    assert.deepEqual(ctx.service.tickPrompt(ctx.ref), {
      counted: true,
      saved: false,
      reason: "below-threshold",
      counter: 1,
    })
    ctx.service.tickPrompt(ctx.ref)
    const beforeAnySave = ctx.service.tickPrompt(ctx.ref)
    assert.equal(beforeAnySave.reason, "no-checkpoint")
    assert.equal(ctx.store.getRuntime(ctx.ref.sessionID).messagesSinceSave, 0)

    ctx.service.save(ctx.ref, { task: { title: "T" }, completedSteps: ["c"] }, { origin: "tool" })
    ctx.service.tickPrompt(ctx.ref)
    ctx.service.tickPrompt(ctx.ref)
    const unchangedTick = ctx.service.tickPrompt(ctx.ref)

    assert.equal(unchangedTick.reason, "unchanged")
    assert.equal(unchangedTick.saved, false)
    assert.equal(ctx.service.listSnapshots(ctx.ref).length, 1, "no snapshot for an unchanged re-save")
  } finally {
    ctx.cleanup()
  }
})

test("the periodic counter is reset by an explicit save and is per session", () => {
  const ctx = setup({ autosaveEvery: 5 })
  try {
    for (let i = 0; i < 4; i++) ctx.service.tickPrompt(ctx.ref)
    ctx.service.save(ctx.ref, { task: { title: "T" } }, { origin: "tool" })
    ctx.store.setRuntime(ctx.ref.sessionID, ctx.ref.projectID, { messagesSinceSave: 0 })

    assert.equal(ctx.store.getRuntime(ctx.ref.sessionID).messagesSinceSave, 0)
    ctx.service.tickPrompt(ctx.other)
    assert.equal(ctx.store.getRuntime(ctx.ref.sessionID).messagesSinceSave, 0, "other sessions must not touch this counter")
    assert.equal(ctx.store.getRuntime(ctx.other.sessionID).messagesSinceSave, 1)
  } finally {
    ctx.cleanup()
  }
})

test("compaction persists state and injects it once", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "T" }, nextSteps: ["continue"] }, { origin: "tool" })

    const first = ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    assert.equal(first.changed, false)
    assert.ok(first.injection?.includes("CHECKPOINT STATE"))
    assert.ok(first.injection?.includes("continue"))

    const second = ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    assert.equal(second.injection, null, "identical state must not be injected twice")

    ctx.service.save(ctx.ref, { nextSteps: ["continue", "more"] }, { origin: "tool" })
    const third = ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    assert.ok(third.injection, "changed state is injected again")
  } finally {
    ctx.cleanup()
  }
})

test("compaction with no prior state synthesizes a clearly marked placeholder and injects nothing", () => {
  const ctx = setup()
  try {
    const outcome = ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    assert.equal(outcome.synthesized, true)
    assert.equal(outcome.injection, null)

    const stored = ctx.service.load(ctx.ref)
    assert.equal(stored.synthesized, true)
    assert.equal(stored.data.task.title, "Auto-synthesized checkpoint")
    assert.ok(stored.data.summary.includes("no task progress was inferred"))
    assert.equal(ctx.service.listSnapshots(ctx.ref).length, 0, "a placeholder must not create snapshot noise")
  } finally {
    ctx.cleanup()
  }
})

test("compaction without synthesis and without a checkpoint is a no-op", () => {
  const ctx = setup()
  try {
    const outcome = ctx.service.handleCompaction(ctx.ref, { synthesize: false })
    assert.equal(outcome.data, null)
    assert.equal(ctx.service.status(ctx.ref).exists, false)
  } finally {
    ctx.cleanup()
  }
})

test("a real save clears the synthesized marker", () => {
  const ctx = setup()
  try {
    ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    assert.equal(ctx.service.status(ctx.ref).synthesized, true)
    ctx.service.save(ctx.ref, { task: { title: "Real work" } }, { origin: "tool" })
    assert.equal(ctx.service.status(ctx.ref).synthesized, false)
  } finally {
    ctx.cleanup()
  }
})

test("clear removes only the calling session's data and its handoff file", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "mine" } }, { origin: "tool" })
    ctx.service.save(ctx.other, { task: { title: "theirs" } }, { origin: "tool" })

    const result = ctx.service.clear(ctx.ref)
    assert.ok(result.snapshots >= 1)
    assert.equal(result.handoffRemoved, true)
    assert.equal(existsSync(handoffFilePath(ctx.projectDir, ctx.ref.sessionID)), false)
    assert.equal(existsSync(handoffFilePath(ctx.projectDir, ctx.other.sessionID)), true)

    assert.equal(ctx.service.status(ctx.ref).exists, false)
    assert.equal(ctx.service.load(ctx.other).data.task.title, "theirs")
  } finally {
    ctx.cleanup()
  }
})

test("status reports counts and synthesis state without leaking another session", () => {
  const ctx = setup()
  try {
    ctx.service.save(
      ctx.ref,
      { task: { title: "T", status: "blocked" }, completedSteps: ["a", "b"], nextSteps: ["c"], blockers: ["d"] },
      { origin: "tool" },
    )
    const status = ctx.service.status(ctx.ref)
    assert.equal(status.exists, true)
    assert.equal(status.title, "T")
    assert.equal(status.status, "blocked")
    assert.equal(status.completedSteps, 2)
    assert.equal(status.nextSteps, 1)
    assert.equal(status.blockers, 1)
    assert.equal(status.snapshotCount, 1)
    assert.equal(status.synthesized, false)

    const other = ctx.service.status(ctx.other)
    assert.equal(other.exists, false)
    assert.equal(other.snapshotCount, 0)
  } finally {
    ctx.cleanup()
  }
})

test("handoff can be regenerated from committed state alone", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "Regenerate me" } }, { origin: "tool" })
    const path = handoffFilePath(ctx.projectDir, ctx.ref.sessionID)
    rmSync(path)
    assert.equal(existsSync(path), false)

    const regenerated = ctx.service.exportHandoff(ctx.ref)
    assert.equal(regenerated, path)
    assert.ok(readFileSync(path, "utf8").includes("Regenerate me"))
  } finally {
    ctx.cleanup()
  }
})

test("a handoff file is never read back as authoritative state", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "truth" } }, { origin: "tool" })
    const path = handoffFilePath(ctx.projectDir, ctx.ref.sessionID)
    const tampered = readFileSync(path, "utf8").replace("truth", "fiction")
    writeFileSync(path, tampered)

    const stored = ctx.service.load(ctx.ref).data
    assert.equal(stored.task.title, "truth")
  } finally {
    ctx.cleanup()
  }
})

test("diagnostics expose driver, schema and health information", () => {
  const ctx = setup()
  try {
    const diagnostics = ctx.service.diagnostics()
    assert.equal(diagnostics.journalMode, "wal")
    assert.equal(diagnostics.integrity, "ok")
    assert.equal(diagnostics.foreignKeyViolations, 0)
    assert.equal(diagnostics.schemaVersion, 1)
    assert.ok(diagnostics.databasePath.endsWith("checkpoints.db"))
  } finally {
    ctx.cleanup()
  }
})

test("a named snapshot of unchanged state is captured without moving updatedAt", () => {
  const ctx = setup()
  try {
    ctx.service.save(ctx.ref, { task: { title: "T" }, completedSteps: ["c"] }, { origin: "tool" })
    const before = ctx.service.load(ctx.ref)

    const outcome = ctx.service.save(ctx.ref, {}, { origin: "tool", snapshotName: "manual-point" })

    assert.equal(outcome.changed, false)
    assert.equal(outcome.snapshotName, "manual-point")
    assert.equal(outcome.handoffPath, null)
    assert.equal(ctx.service.load(ctx.ref).data.updatedAt, before.data.updatedAt, "unchanged content must not move updatedAt")
    assert.equal(ctx.service.loadSnapshot(ctx.ref, "manual-point").data.task.title, "T")
    assert.equal(ctx.service.listSnapshots(ctx.ref).length, 2)
  } finally {
    ctx.cleanup()
  }
})

test("an unchanged save does not clear a synthesized marker or misreport synthesis", () => {
  const ctx = setup()
  try {
    ctx.service.handleCompaction(ctx.ref, { synthesize: true })
    const status = ctx.service.status(ctx.ref)
    assert.equal(status.synthesized, true)

    const outcome = ctx.service.save(ctx.ref, {}, { origin: "periodic" })
    assert.equal(outcome.changed, false)
    assert.equal(ctx.service.status(ctx.ref).synthesized, true, "a no-op save must not change synthesis state")
  } finally {
    ctx.cleanup()
  }
})

test("saving with only whitespace-ish empty values is still a real change once", () => {
  const ctx = setup()
  try {
    const first = ctx.service.save(ctx.ref, { summary: "" }, { origin: "tool" })
    assert.equal(first.changed, true)
    const second = ctx.service.save(ctx.ref, {}, { origin: "tool" })
    assert.equal(second.changed, false)
    assert.equal(ctx.service.load(ctx.ref).data.summary, "")
  } finally {
    ctx.cleanup()
  }
})
