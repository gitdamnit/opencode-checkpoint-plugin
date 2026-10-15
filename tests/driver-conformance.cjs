// SQLite driver conformance probe — runs under Node >=22.5 and Bun >=1.4.
// Exported as run() so the same code can be executed inside the OpenCode runtime.
const { mkdtempSync, rmSync, statSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")

function driverByName(name) {
  if (name === "node:sqlite") {
    const m = require("node:sqlite")
    return { name, DatabaseSync: m.DatabaseSync }
  }
  if (name === "bun:sqlite") {
    const m = require("bun:sqlite")
    return { name, DatabaseSync: m.Database }
  }
  throw new Error("unknown driver " + name)
}

function run(opts = {}) {
  const driverName = opts.driver || process.env.DRIVER || "node:sqlite"
  const results = {}
  const scratch = opts.dir || mkdtempSync(join(tmpdir(), "sqlite-conf-"))
  const dbPath = join(scratch, "test.db")
  const rec = (k, v) => (results[k] = v)
  const attempt = (k, fn) => {
    try { rec(k, { ok: true, value: fn() }) }
    catch (e) { rec(k, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }) }
  }

  let DatabaseSync
  try {
    const d = driverByName(driverName)
    DatabaseSync = d.DatabaseSync
    rec("driver", d.name)
    rec("versions", { node: process.versions.node, bun: process.versions.bun, sqlite: process.versions.sqlite })
  } catch (e) {
    rec("fatal", String(e && e.message ? e.message : e))
    return results
  }

  let db
  attempt("open", () => { db = new DatabaseSync(dbPath); return "opened" })
  if (!db) return results

  attempt("wal", () => { db.exec("PRAGMA journal_mode = WAL"); return db.prepare("PRAGMA journal_mode").get() })
  attempt("synchronous", () => { db.exec("PRAGMA synchronous = NORMAL"); return db.prepare("PRAGMA synchronous").get() })
  attempt("fk_on", () => { db.exec("PRAGMA foreign_keys = ON"); return db.prepare("PRAGMA foreign_keys").get() })
  attempt("busy_timeout", () => { db.exec("PRAGMA busy_timeout = 5000"); return db.prepare("PRAGMA busy_timeout").get() })
  attempt("user_version", () => {
    db.exec("PRAGMA user_version = 3")
    return db.prepare("PRAGMA user_version").get()
  })

  attempt("schema", () => {
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, dir TEXT NOT NULL UNIQUE);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT, steps TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_ck_session ON checkpoints(session_id);
      CREATE INDEX idx_ck_created ON checkpoints(created_at DESC);
    `)
    return "schema ok"
  })

  attempt("fk_enforced", () => {
    let threw = false
    try { db.prepare("INSERT INTO sessions (id, project_id) VALUES (?, ?)").run("s-bad", "no-such-project") }
    catch { threw = true }
    return { threw, rows: db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c }
  })

  attempt("prepared_insert", () => {
    db.prepare("INSERT INTO projects (id, dir) VALUES (?, ?)").run("p1", "/x")
    db.prepare("INSERT INTO sessions (id, project_id) VALUES (?, ?)").run("s1", "p1")
    const ins = db.prepare("INSERT INTO checkpoints (session_id, title, steps, created_at) VALUES (?, ?, ?, ?)")
    ins.run("s1", "t1", JSON.stringify(["a", "b"]), new Date().toISOString())
    return db.prepare("SELECT COUNT(*) AS c FROM checkpoints").get().c
  })

  attempt("json_extract", () => db.prepare("SELECT json_extract(steps, '$[1]') AS v FROM checkpoints WHERE session_id = ?").get("s1").v)

  attempt("unique_violation", () => {
    let threw = false
    try { db.prepare("INSERT INTO checkpoints (session_id, title, created_at) VALUES (?, ?, ?)").run("s1", "dup", new Date().toISOString()) }
    catch (e) { threw = /UNIQUE/i.test(String(e.message)) }
    return { threw }
  })

  attempt("tx_commit_rollback", () => {
    db.exec("BEGIN IMMEDIATE")
    db.prepare("INSERT INTO projects (id, dir) VALUES (?, ?)").run("p2", "/y")
    db.exec("ROLLBACK")
    const afterRollback = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id='p2'").get().c
    db.exec("BEGIN IMMEDIATE")
    db.prepare("INSERT INTO projects (id, dir) VALUES (?, ?)").run("p3", "/z")
    db.exec("COMMIT")
    const afterCommit = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id='p3'").get().c
    return { afterRollback, afterCommit }
  })

  attempt("savepoints", () => {
    db.exec("BEGIN IMMEDIATE")
    db.exec("SAVEPOINT sp1")
    db.prepare("INSERT INTO projects (id, dir) VALUES (?, ?)").run("p4", "/w")
    db.exec("ROLLBACK TO sp1")
    db.exec("RELEASE sp1")
    db.exec("COMMIT")
    return db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id='p4'").get().c
  })

  attempt("concurrent_two_handles", () => {
    const db2 = new DatabaseSync(dbPath)
    db2.exec("PRAGMA busy_timeout = 5000")
    db2.exec("BEGIN IMMEDIATE")
    db2.prepare("INSERT INTO projects (id, dir) VALUES (?, ?)").run("p5", "/c5")
    db.exec("PRAGMA busy_timeout = 250")
    let writerBlocked = false
    try { db.exec("BEGIN IMMEDIATE") } catch { writerBlocked = true }
    db2.exec("COMMIT")
    const seen = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id='p5'").get().c
    try { db.exec("ROLLBACK") } catch {}
    db2.close()
    return { writerBlocked, seen }
  })

  attempt("integrity_check", () => db.prepare("PRAGMA integrity_check").get())
  attempt("foreign_key_check", () => ({ violations: db.prepare("PRAGMA foreign_key_check").all().length }))

  attempt("cascade_delete", () => {
    db.exec("PRAGMA foreign_keys = ON")
    db.prepare("DELETE FROM projects WHERE id='p1'").run()
    return {
      sessionsLeft: db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE project_id='p1'").get().c,
      checkpointsLeft: db.prepare("SELECT COUNT(*) AS c FROM checkpoints").get().c,
    }
  })

  attempt("reopen_persistence", () => {
    db.close()
    db = new DatabaseSync(dbPath)
    return db.prepare("SELECT COUNT(*) AS c FROM projects").get().c
  })

  attempt("backup_api", () => (typeof db.backup === "function" ? "backup() available" : "backup() not exposed"))
  attempt("close_and_perms", () => { db.close(); return { mode: (statSync(dbPath).mode & 0o777).toString(8) } })

  rmSync(scratch, { recursive: true, force: true })
  return results
}

module.exports = { run }

if (require.main === module) {
  console.log(JSON.stringify(run(), null, 2))
}
