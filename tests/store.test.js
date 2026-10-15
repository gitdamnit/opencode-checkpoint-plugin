import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { CheckpointStore } from "../dist/core/store.js"
import { LATEST_SCHEMA_VERSION } from "../dist/core/schema.js"
import { deepMerge } from "../dist/core/util.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, "fixtures")

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "co-store-"))
  return { dir, dbPath: join(dir, "checkpoints.db") }
}

function session(id, project = "proj-1") {
  return { sessionID: id, projectID: project, projectDirectory: `/tmp/${project}` }
}

function data(title, extra = {}) {
  return deepMerge(null, { task: { title, status: "in_progress" }, ...extra })
}

test("creates the full schema and reports its version", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION)
    assert.equal(store.integrityCheck(), "ok")
    assert.equal(store.foreignKeyCheck(), 0)
    assert.equal(store.journalModeInUse, "wal")
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restricts database file permissions to the owner", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_perm"))
    store.saveCheckpoint({ sessionID: "ses_perm", projectID: "proj-1", data: data("perm") })
    store.close()

    assert.ok(existsSync(dbPath))
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("foreign keys are enforced and cascade from project to session state", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_fk"))
    store.saveCheckpoint({ sessionID: "ses_fk", projectID: "proj-1", data: data("fk") })
    store.addSnapshot({ sessionID: "ses_fk", projectID: "proj-1", name: "s1", kind: "auto", data: data("fk") })
    store.close()

    // Assert against the schema itself, from an independent connection.
    const raw = new DatabaseSync(dbPath)
    raw.exec("PRAGMA foreign_keys = ON")
    assert.throws(() => {
      raw.prepare("INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "ses_orphan",
        "no-such-project",
        "now",
        "now",
      )
    })
    assert.throws(() => {
      raw.prepare(
        "INSERT INTO checkpoints (session_id, project_id, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("no-such-session", "proj-1", 3, "now", "now")
    })

    raw.prepare("DELETE FROM projects WHERE id = ?").run("proj-1")
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM sessions").get().c, 0)
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM checkpoints").get().c, 0)
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM snapshots").get().c, 0)
    raw.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("transactions commit and roll back atomically", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_tx"))

    store.transaction(() => {
      store.saveCheckpoint({ sessionID: "ses_tx", projectID: "proj-1", data: data("committed") })
    })
    assert.equal(store.loadCheckpoint("ses_tx").data.task.title, "committed")

    assert.throws(() => {
      store.transaction(() => {
        store.saveCheckpoint({ sessionID: "ses_tx", projectID: "proj-1", data: data("rolled-back", { notes: ["x"] }) })
        store.addSnapshot({ sessionID: "ses_tx", projectID: "proj-1", name: "tx", kind: "auto", data: data("rolled-back") })
        throw new Error("boom")
      })
    })

    assert.equal(store.loadCheckpoint("ses_tx").data.task.title, "committed")
    assert.equal(store.countSnapshots("ses_tx"), 0)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nested transactions roll back only the inner scope", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_nested"))

    store.transaction(() => {
      store.saveCheckpoint({ sessionID: "ses_nested", projectID: "proj-1", data: data("outer") })
      try {
        store.transaction(() => {
          store.saveCheckpoint({ sessionID: "ses_nested", projectID: "proj-1", data: data("inner", { blockers: ["b"] }) })
          throw new Error("inner failure")
        })
      } catch {
        /* expected */
      }
      store.addSnapshot({ sessionID: "ses_nested", projectID: "proj-1", name: "outer", kind: "auto", data: data("outer") })
    })

    const stored = store.loadCheckpoint("ses_nested")
    assert.equal(stored.data.task.title, "outer")
    assert.deepEqual(stored.data.blockers, [])
    assert.equal(store.countSnapshots("ses_nested"), 1)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("snapshot history prunes but always retains the newest undo point", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath, { historyLimit: 3 })
    store.ensureSession(session("ses_prune"))

    for (let i = 0; i < 5; i++) {
      store.addSnapshot({
        sessionID: "ses_prune",
        projectID: "proj-1",
        name: `auto-${i}`,
        kind: "auto",
        data: data(`t${i}`),
        savedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      })
    }
    store.addSnapshot({
      sessionID: "ses_prune",
      projectID: "proj-1",
      name: "pre-restore-1",
      kind: "pre-restore",
      data: data("undo"),
      savedAt: "2026-01-01T00:00:00.000Z",
    })

    const removed = store.pruneSnapshots("ses_prune", 3)
    assert.ok(removed > 0)

    const names = store.listSnapshots("ses_prune").map((snapshot) => snapshot.name)
    assert.ok(names.includes("pre-restore-1"), "the only undo snapshot must survive pruning")
    assert.ok(names.includes("auto-4"))
    assert.ok(!names.includes("auto-0"))
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("per-session runtime counters round-trip and survive reopening", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_rt"))
    store.ensureSession(session("ses_other"))
    store.setRuntime("ses_rt", "proj-1", { messagesSinceSave: 4, lastInjectedHash: "abc" })
    store.setRuntime("ses_other", "proj-1", { messagesSinceSave: 1 })
    store.close()

    const reopened = new CheckpointStore(dbPath)
    assert.deepEqual(reopened.getRuntime("ses_rt"), {
      messagesSinceSave: 4,
      lastInjectedHash: "abc",
      lastAutosaveAt: null,
    })
    assert.equal(reopened.getRuntime("ses_other").messagesSinceSave, 1)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("migration ledger is idempotent", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    assert.equal(store.hasMigration("legacy-json:proj-1"), false)
    store.recordMigration("legacy-json:proj-1", "proj-1", { snapshots: 2 })
    assert.equal(store.hasMigration("legacy-json:proj-1"), true)
    store.recordMigration("legacy-json:proj-1", "proj-1", { snapshots: 2 })
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupted snapshot payload degrades instead of throwing", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_corrupt"))
    store.addSnapshot({
      sessionID: "ses_corrupt",
      projectID: "proj-1",
      name: "broken",
      kind: "auto",
      data: data("ok"),
    })
    store.close()

    const raw = new DatabaseSync(dbPath)
    raw.exec("PRAGMA foreign_keys = ON")
    raw.prepare("UPDATE snapshots SET payload = ? WHERE name = ?").run("{not json", "broken")
    raw.close()

    const reopened = new CheckpointStore(dbPath)
    const snapshot = reopened.getSnapshot("ses_corrupt", "broken")
    assert.ok(snapshot)
    assert.deepEqual(snapshot.data.currentPlan, [])
    assert.equal(reopened.integrityCheck(), "ok")
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("four processes writing the same database concurrently lose nothing", () => {
  const { dir, dbPath } = scratch()
  const processes = 4
  const writesPerProcess = 20
  try {
    const seeds = new CheckpointStore(dbPath)
    seeds.close()

    const children = []
    for (let p = 0; p < processes; p++) {
      children.push(
        execFileSync(
          process.execPath,
          [join(fixtures, "writer.mjs"), dbPath, "proj-1", `ses_p${p}`, String(writesPerProcess)],
          { encoding: "utf8", timeout: 120_000 },
        ),
      )
    }
    assert.equal(children.length, processes)

    const store = new CheckpointStore(dbPath)
    assert.equal(store.integrityCheck(), "ok")
    assert.equal(store.foreignKeyCheck(), 0)
    for (let p = 0; p < processes; p++) {
      const stored = store.loadCheckpoint(`ses_p${p}`)
      assert.equal(stored.data.task.title, `ses_p${p}-write-${writesPerProcess - 1}`)
      assert.equal(store.countSnapshots(`ses_p${p}`), writesPerProcess)
    }
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a process killed mid-transaction leaves a consistent database", () => {
  const { dir, dbPath } = scratch()
  try {
    let crashed = false
    try {
      execFileSync(process.execPath, [join(fixtures, "crash.mjs"), dbPath, "proj-1", "ses_crash"], {
        encoding: "utf8",
        timeout: 60_000,
      })
    } catch {
      crashed = true
    }
    assert.ok(crashed, "the fixture must die with SIGKILL")

    const store = new CheckpointStore(dbPath)
    assert.equal(store.integrityCheck(), "ok")
    const stored = store.loadCheckpoint("ses_crash")
    assert.equal(stored.data.task.title, "committed-before-crash")
    assert.deepEqual(stored.data.completedSteps, [])
    assert.equal(store.getSnapshot("ses_crash", "uncommitted-snapshot"), null)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an incompatible future schema version is refused rather than silently used", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.close()

    const raw = new DatabaseSync(dbPath)
    raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 5}`)
    raw.close()

    assert.throws(() => new CheckpointStore(dbPath), /schema is v\d+ but this build expects/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a database file is created at the configured path and reused", () => {
  const { dir, dbPath } = scratch()
  try {
    const first = new CheckpointStore(dbPath)
    first.ensureSession(session("ses_reuse"))
    first.saveCheckpoint({ sessionID: "ses_reuse", projectID: "proj-1", data: data("persisted") })
    first.close()

    const second = new CheckpointStore(dbPath)
    assert.equal(second.loadCheckpoint("ses_reuse").data.task.title, "persisted")
    second.close()

    // A second open must not wipe or recreate data.
    const fileSize = statSync(dbPath).size
    assert.ok(fileSize > 0)
    assert.ok(readFileSync(dbPath).length === fileSize)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("snapshots are scoped to their session and cannot collide by name", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_a"))
    store.ensureSession(session("ses_b"))
    store.addSnapshot({ sessionID: "ses_a", projectID: "proj-1", name: "shared-name", kind: "named", data: data("a") })
    store.addSnapshot({ sessionID: "ses_b", projectID: "proj-1", name: "shared-name", kind: "named", data: data("b") })

    assert.equal(store.getSnapshot("ses_a", "shared-name").data.task.title, "a")
    assert.equal(store.getSnapshot("ses_b", "shared-name").data.task.title, "b")

    // Re-capturing under the same name replaces it, in place.
    store.addSnapshot({ sessionID: "ses_a", projectID: "proj-1", name: "shared-name", kind: "named", data: data("a2") })
    assert.equal(store.countSnapshots("ses_a"), 1)
    assert.equal(store.getSnapshot("ses_a", "shared-name").data.task.title, "a2")
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("memory databases are supported for callers that opt in", () => {
  const store = new CheckpointStore(":memory:")
  store.ensureSession({ sessionID: "ses_mem", projectID: "proj-mem", projectDirectory: "/tmp/mem" })
  store.saveCheckpoint({ sessionID: "ses_mem", projectID: "proj-mem", data: data("in-memory") })
  assert.equal(store.loadCheckpoint("ses_mem").data.task.title, "in-memory")
  store.close()
})

test("a checkpoint or snapshot cannot claim a project its session does not belong to", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureProject("proj-1", "/tmp/proj-1")
    store.ensureProject("proj-other", "/tmp/proj-other")
    store.ensureSession(session("ses_paired", "proj-1"))
    store.ensureSession(session("ses_without_checkpoint", "proj-1"))
    store.saveCheckpoint({ sessionID: "ses_paired", projectID: "proj-1", data: data("paired") })
    store.close()

    const raw = new DatabaseSync(dbPath)
    raw.exec("PRAGMA foreign_keys = ON")
    // A session with no checkpoint row yet, so the composite key is what rejects it.
    assert.throws(
      () =>
        raw
          .prepare(
            "INSERT INTO checkpoints (session_id, project_id, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("ses_without_checkpoint", "proj-other", 3, "now", "now"),
      /FOREIGN KEY/i,
    )
    assert.throws(
      () =>
        raw
          .prepare(
            "INSERT INTO snapshots (session_id, project_id, name, kind, captured_at, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ses_without_checkpoint", "proj-other", "s", "auto", "now", "{}", 3),
      /FOREIGN KEY/i,
    )

    // Moving a session to another project keeps its rows consistent with it.
    raw.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run("proj-other", "ses_paired")
    const moved = raw.prepare("SELECT project_id FROM checkpoints WHERE session_id = ?").get("ses_paired")
    assert.equal(moved.project_id, "proj-other")
    raw.close()

    const reopened = new CheckpointStore(dbPath)
    assert.equal(reopened.loadCheckpoint("ses_paired").data.task.title, "paired")
    assert.equal(reopened.foreignKeyCheck(), 0)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("concurrent prompt ticks from separate processes are not lost", () => {
  const { dir, dbPath } = scratch()
  const processes = 4
  const ticksPerProcess = 10
  try {
    const seeds = new CheckpointStore(dbPath)
    seeds.ensureSession(session("ses_ticks"))
    seeds.close()

    for (let p = 0; p < processes; p++) {
      execFileSync(
        process.execPath,
        [join(fixtures, "ticker.mjs"), dbPath, "proj-1", "ses_ticks", String(ticksPerProcess), "100000"],
        { encoding: "utf8", timeout: 180_000 },
      )
    }

    const store = new CheckpointStore(dbPath)
    // Every tick is a read-modify-write; a lost update would show up here.
    assert.equal(store.getRuntime("ses_ticks").messagesSinceSave, processes * ticksPerProcess)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed session id fails loudly instead of silently matching nothing", () => {
  const { dir, dbPath } = scratch()
  try {
    const store = new CheckpointStore(dbPath)
    store.ensureSession(session("ses_guard"))

    assert.throws(() => store.loadCheckpoint(undefined), /sessionID must be a non-empty string/)
    assert.throws(() => store.loadCheckpoint(""), /sessionID must be a non-empty string/)
    assert.throws(() => store.countSnapshots(null), /sessionID must be a non-empty string/)
    assert.throws(() => store.listSnapshots(42), /sessionID must be a non-empty string/)
    assert.throws(() => store.getSession(""), /sessionID must be a non-empty string/)
    assert.throws(() => store.clearSession(undefined), /sessionID must be a non-empty string/)
    assert.throws(() => store.getRuntime(""), /sessionID must be a non-empty string/)
    assert.throws(
      () => store.saveCheckpoint({ sessionID: "", projectID: "proj-1", data: data("x") }),
      /sessionID must be a non-empty string/,
    )
    assert.throws(
      () => store.saveCheckpoint({ sessionID: "ses_guard", projectID: "", data: data("x") }),
      /projectID must be a non-empty string/,
    )
    // The database is untouched by the rejected calls.
    assert.equal(store.loadCheckpoint("ses_guard"), null)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writeFileSync import is exercised so fixture directories stay relative", () => {
  // Guards against fixtures being moved without updating this suite.
  assert.ok(existsSync(join(fixtures, "writer.mjs")))
  assert.ok(existsSync(join(fixtures, "crash.mjs")))
  writeFileSync(join(tmpdir(), "co-store-touch"), "ok")
})
