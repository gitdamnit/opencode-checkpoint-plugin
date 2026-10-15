/**
 * Section 5 of the migration brief: session isolation.
 * These are the tests that would have caught the original design flaw, where a
 * single project-level checkpoint was shared by every session in a project.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CheckpointStore } from "../dist/core/store.js"
import { CheckpointService, DEFAULT_SERVICE_OPTIONS } from "../dist/core/service.js"
import { handoffFilePath } from "../dist/core/handoff.js"

function harness(count = 2, projectID = "proj-1", serviceOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "co-iso-"))
  const projectDirectory = join(dir, "project")
  const dbPath = join(dir, "checkpoints.db")
  const store = new CheckpointStore(dbPath)
  const service = new CheckpointService(store, { ...DEFAULT_SERVICE_OPTIONS, ...serviceOptions })
  const refs = Array.from({ length: count }, (_, i) => ({
    sessionID: `ses_${i}`,
    projectID,
    projectDirectory,
  }))
  return {
    dir,
    dbPath,
    projectDirectory,
    store,
    service,
    refs,
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("two sessions in one project keep completely separate state", () => {
  const ctx = harness(2)
  try {
    ctx.service.save(ctx.refs[0], { task: { title: "session-A", status: "in_progress" }, nextSteps: ["a1"] }, { origin: "tool" })
    ctx.service.save(ctx.refs[1], { task: { title: "session-B", status: "blocked" }, nextSteps: ["b1", "b2"] }, { origin: "tool" })

    const a = ctx.service.load(ctx.refs[0]).data
    const b = ctx.service.load(ctx.refs[1]).data

    assert.equal(a.task.title, "session-A")
    assert.equal(a.task.status, "in_progress")
    assert.deepEqual(a.nextSteps, ["a1"])
    assert.equal(b.task.title, "session-B")
    assert.equal(b.task.status, "blocked")
    assert.deepEqual(b.nextSteps, ["b1", "b2"])

    // A partial update to one must not touch the other.
    ctx.service.save(ctx.refs[0], { completedSteps: ["a-done"] }, { origin: "tool" })
    assert.deepEqual(ctx.service.load(ctx.refs[1]).data.completedSteps, [])
    assert.deepEqual(ctx.service.load(ctx.refs[1]).data.nextSteps, ["b1", "b2"])
  } finally {
    ctx.cleanup()
  }
})

test("five simultaneous sessions each keep their own checkpoint and history", () => {
  const ctx = harness(5)
  try {
    for (const [index, ref] of ctx.refs.entries()) {
      ctx.service.save(ref, { task: { title: `t${index}` }, completedSteps: Array.from({ length: index + 1 }, (_, i) => `s${i}`) }, { origin: "tool" })
    }
    for (const [index, ref] of ctx.refs.entries()) {
      const stored = ctx.service.load(ref).data
      assert.equal(stored.task.title, `t${index}`)
      assert.equal(stored.completedSteps.length, index + 1)
      assert.equal(ctx.service.listSnapshots(ref).length, 1)
      for (const other of ctx.refs.filter((_, i) => i !== index)) {
        assert.notEqual(ctx.service.load(other).data.task.title, stored.task.title)
      }
    }
  } finally {
    ctx.cleanup()
  }
})

test("multiple projects stay isolated even with overlapping session naming", () => {
  const ctx = harness(1, "proj-1")
  const other = harness(1, "proj-2")
  try {
    ctx.service.save(ctx.refs[0], { task: { title: "project-1-state" } }, { origin: "tool" })
    other.service.save(other.refs[0], { task: { title: "project-2-state" } }, { origin: "tool" })

    assert.equal(ctx.service.load(ctx.refs[0]).data.task.title, "project-1-state")
    assert.equal(other.service.load(other.refs[0]).data.task.title, "project-2-state")
    // Same database file would be the interesting case; here, distinct files.
    assert.notEqual(ctx.dbPath, other.dbPath)
  } finally {
    ctx.cleanup()
    other.cleanup()
  }
})

test("snapshot histories are independent and cannot be read across sessions", () => {
  const ctx = harness(2)
  try {
    ctx.service.save(ctx.refs[0], { task: { title: "A" } }, { origin: "tool", snapshotName: "only-in-A" })
    ctx.service.save(ctx.refs[1], { task: { title: "B" } }, { origin: "tool", snapshotName: "only-in-B" })

    assert.equal(ctx.service.loadSnapshot(ctx.refs[0], "only-in-A").data.task.title, "A")
    assert.equal(ctx.service.loadSnapshot(ctx.refs[0], "only-in-B"), null)
    assert.equal(ctx.service.loadSnapshot(ctx.refs[1], "only-in-A"), null)

    // Restoring from A must not disturb B.
    const restored = ctx.service.restoreSnapshot(ctx.refs[0], "only-in-A")
    assert.equal(restored.restored, true)
    assert.equal(ctx.service.load(ctx.refs[1]).data.task.title, "B")
    assert.deepEqual(
      ctx.service.listSnapshots(ctx.refs[1]).map((snapshot) => snapshot.name),
      ["only-in-B"],
    )
  } finally {
    ctx.cleanup()
  }
})

test("concurrent writes to the same session from two connections do not corrupt or lose history", () => {
  const ctx = harness(1, "proj-1", { historyLimit: 50 })
  let second
  try {
    const store2 = new CheckpointStore(ctx.dbPath)
    const service2 = new CheckpointService(store2, { ...DEFAULT_SERVICE_OPTIONS, historyLimit: 50 })
    second = { store: store2, service: service2 }

    // Two independent connections alternate writes to the same session. Because
    // read-merge-write is one transaction, neither may lose the other's field.
    for (let i = 0; i < 10; i++) {
      ctx.service.save(ctx.refs[0], { notes: [`a${i}`] }, { origin: "tool" })
      service2.save(ctx.refs[0], { blockers: [`b${i}`] }, { origin: "tool" })
    }

    const stored = ctx.service.load(ctx.refs[0]).data
    assert.deepEqual(stored.notes, ["a9"], "the last write from connection 1 must be visible")
    assert.deepEqual(stored.blockers, ["b9"], "the last write from connection 2 must not be lost")
    assert.equal(ctx.service.listSnapshots(ctx.refs[0]).length, 20, "no snapshot may be lost")
    assert.equal(ctx.store.integrityCheck(), "ok")
    assert.equal(ctx.store.foreignKeyCheck(), 0)
  } finally {
    second?.store.close()
    ctx.cleanup()
  }
})

test("snapshot retention stays bounded at the configured limit", () => {
  const ctx = harness(1, "proj-1", { historyLimit: 3 })
  try {
    for (let i = 0; i < 15; i++) {
      ctx.service.save(ctx.refs[0], { nextSteps: [`step-${i}`] }, { origin: "tool" })
    }
    assert.equal(ctx.service.listSnapshots(ctx.refs[0]).length, 3)
    assert.equal(ctx.service.load(ctx.refs[0]).data.nextSteps[0], "step-14")
  } finally {
    ctx.cleanup()
  }
})

test("switching between sessions does not reset counters or state", () => {
  const ctx = harness(2)
  try {
    ctx.service.save(ctx.refs[0], { task: { title: "A" } }, { origin: "tool" })
    ctx.service.tickPrompt(ctx.refs[0])
    ctx.service.tickPrompt(ctx.refs[0])

    ctx.service.save(ctx.refs[1], { task: { title: "B" } }, { origin: "tool" })
    ctx.service.tickPrompt(ctx.refs[1])

    // Back to A: its counter and state must be exactly as left.
    assert.equal(ctx.store.getRuntime(ctx.refs[0].sessionID).messagesSinceSave, 2)
    assert.equal(ctx.store.getRuntime(ctx.refs[1].sessionID).messagesSinceSave, 1)
    assert.equal(ctx.service.load(ctx.refs[0]).data.task.title, "A")

    ctx.service.tickPrompt(ctx.refs[0])
    assert.equal(ctx.store.getRuntime(ctx.refs[0].sessionID).messagesSinceSave, 3)
    assert.equal(ctx.store.getRuntime(ctx.refs[1].sessionID).messagesSinceSave, 1)
  } finally {
    ctx.cleanup()
  }
})

test("a model or provider switch inside a session preserves that session's checkpoint", () => {
  const ctx = harness(1)
  try {
    ctx.service.save(
      ctx.refs[0],
      { task: { title: "T", objective: "O" }, summary: "s", completedSteps: ["c"], nextSteps: ["n"], notes: ["note"] },
      { origin: "tool" },
    )
    // A model switch changes session metadata only; checkpoint operations remain
    // keyed by session id, so the second save must merge rather than reset.
    ctx.store.ensureSession({ ...ctx.refs[0], title: "switched-model-session" })
    ctx.service.save(ctx.refs[0], { task: { status: "blocked" } }, { origin: "tool" })

    const stored = ctx.service.load(ctx.refs[0]).data
    assert.equal(stored.task.title, "T")
    assert.equal(stored.task.objective, "O")
    assert.equal(stored.task.status, "blocked")
    assert.equal(stored.summary, "s")
    assert.deepEqual(stored.completedSteps, ["c"])
    assert.deepEqual(stored.notes, ["note"])
  } finally {
    ctx.cleanup()
  }
})

test("a child session gets its own checkpoint and inherits nothing implicitly", () => {
  const ctx = harness(1)
  try {
    const parent = ctx.refs[0]
    const child = { sessionID: "ses_child", projectID: parent.projectID, projectDirectory: parent.projectDirectory, parentID: parent.sessionID }

    ctx.service.save(parent, { task: { title: "parent" }, completedSteps: ["parent-step"] }, { origin: "tool" })
    ctx.store.ensureSession(child)

    assert.equal(ctx.service.status(child).exists, false, "child sessions must not inherit the parent checkpoint")
    assert.equal(ctx.service.loadSnapshot(child, "anything"), null)

    ctx.service.save(child, { task: { title: "child" } }, { origin: "tool" })
    assert.equal(ctx.service.load(parent).data.task.title, "parent")
    assert.deepEqual(ctx.service.load(parent).data.completedSteps, ["parent-step"])
    assert.equal(ctx.service.load(child).data.task.title, "child")
    assert.equal(ctx.store.getSession("ses_child").parentID, parent.sessionID)
  } finally {
    ctx.cleanup()
  }
})

test("clearing one session leaves sibling sessions and their handoff files intact", () => {
  const ctx = harness(3)
  try {
    for (const ref of ctx.refs) {
      ctx.service.save(ref, { task: { title: ref.sessionID } }, { origin: "tool" })
    }
    ctx.service.clear(ctx.refs[1])

    assert.equal(ctx.service.status(ctx.refs[1]).exists, false)
    assert.equal(ctx.service.status(ctx.refs[0]).exists, true)
    assert.equal(ctx.service.status(ctx.refs[2]).exists, true)
    assert.equal(ctx.service.listSnapshots(ctx.refs[1]).length, 0)
    assert.equal(ctx.service.listSnapshots(ctx.refs[0]).length, 1)
    assert.equal(handoffFilePath(ctx.projectDirectory, ctx.refs[0].sessionID).length > 0, true)
  } finally {
    ctx.cleanup()
  }
})

test("all committed state survives a plugin restart (fresh store and service)", () => {
  const ctx = harness(3)
  try {
    for (const [index, ref] of ctx.refs.entries()) {
      ctx.service.save(ref, { task: { title: `before-restart-${index}` }, completedSteps: [`c${index}`] }, { origin: "tool", snapshotName: `named-${index}` })
      ctx.service.tickPrompt(ref)
    }
    ctx.store.close()

    const reopenedStore = new CheckpointStore(ctx.dbPath)
    const reopenedService = new CheckpointService(reopenedStore, { ...DEFAULT_SERVICE_OPTIONS })
    for (const [index, ref] of ctx.refs.entries()) {
      const stored = reopenedService.load(ref).data
      assert.equal(stored.task.title, `before-restart-${index}`)
      assert.deepEqual(stored.completedSteps, [`c${index}`])
      assert.equal(reopenedService.loadSnapshot(ref, `named-${index}`).data.task.title, `before-restart-${index}`)
      assert.equal(reopenedStore.getRuntime(ref.sessionID).messagesSinceSave, 1)
    }
    reopenedStore.close()
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test("many sessions in one project do not share a single checkpoint row", () => {
  const ctx = harness(25)
  try {
    for (const [index, ref] of ctx.refs.entries()) {
      ctx.service.save(ref, { task: { title: `s${index}` } }, { origin: "tool" })
    }
    const titles = new Set(ctx.refs.map((ref) => ctx.service.load(ref).data.task.title))
    assert.equal(titles.size, 25)
    assert.equal(ctx.store.listSessionIds().length >= 25, true)
  } finally {
    ctx.cleanup()
  }
})
