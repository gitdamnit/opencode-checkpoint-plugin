/**
 * Real OpenCode V2 runtime integration test.
 *
 * "It compiles" is not evidence that a plugin works. This script:
 *   1. packs the package with `npm pack` and installs the tarball into a clean
 *      throwaway project (so the *published artifact* is what gets tested);
 *   2. launches the real `opencode` binary in `--standalone` mode with the plugin
 *      configured, in an isolated project;
 *   3. asserts the plugin loaded and opened the database in OpenCode's own
 *      runtime (Bun), from the plugin's own log line;
 *   4. drives the tools through a real model turn;
 *   5. verifies the result by reading the SQLite file directly, which is
 *      independent of anything the model says;
 *   6. verifies session isolation by asking a *different* session for status.
 *
 * Usage: npm run test:opencode
 * Environment: OPENCODE_BIN (default "opencode"), INTEGRATION_TIMEOUT_MS (default 300000)
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode"
const timeout = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 300_000)

const results = []
let failures = 0
let advisories = 0

function record(name, ok, detail = "") {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

/**
 * Some runtime facts cannot be asserted reliably from the CLI. OpenCode 2.0.21
 * activates a location's plugins asynchronously, so a short `opencode run` can
 * finish before the plugin host has enumerated them, and it may interact with an
 * already-running shared service. Those observations are reported as ADVISORY so
 * that an environment quirk is never mistaken for a code defect, and a genuine
 * load error (which *is* deterministic) is still a hard failure.
 */
function advisory(name, ok, detail = "") {
  if (!ok) advisories++
  console.log(`${ok ? "PASS" : "ADVISORY"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

/**
 * The surrounding agent runtime exports OPENCODE_* variables (notably
 * OPENCODE_SESSION_ID). A nested `opencode` run inherits them and would resume
 * *that* session in *that* directory instead of the throwaway project, so they
 * are stripped unless the caller sets them deliberately.
 */
function sanitizedEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^OPENCODE/i.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

function run(args, options = {}) {
  const result = spawnSync(opencodeBin, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout,
    env: sanitizedEnv(options.env),
    // stdin must be inherited. With a piped stdin OpenCode 2.0.21 does not
    // enumerate or load plugins at all; stdout/stderr stay captured.
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  }
}

/**
 * OpenCode 2.0.21 activates a location's plugins asynchronously, so a short
 * `opencode run` can finish its turn before the plugin host has enumerated them.
 * In practice this is intermittent rather than constant; retrying the invocation
 * is the reliable way to observe plugin behaviour. Attempts are reported so the
 * behaviour is visible rather than hidden.
 */
function runUntil(args, options, predicate, label, attempts = 4) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = run(args, options)
    if (predicate(last)) {
      if (attempt > 1) console.log(`  (${label}: satisfied on attempt ${attempt}/${attempts})`)
      return { result: last, attempts: attempt }
    }
    if (attempt < attempts) console.log(`  (${label}: attempt ${attempt}/${attempts} not yet satisfied, retrying)`)
  }
  return { result: last, attempts }
}

function main() {
  const workRoot = mkdtempSync(join(process.env.TMPDIR_OVERRIDE ?? tmpdir(), "co-integration-"))
  const project = join(workRoot, "project")
  const packDir = join(workRoot, "pack")
  const dbPath = join(workRoot, "probe.db")
  mkdirSync(project, { recursive: true })
  mkdirSync(packDir, { recursive: true })

  console.log(`work dir:   ${workRoot}`)
  console.log(`project:    ${project}`)
  console.log(`database:   ${dbPath}`)
  console.log(`opencode:   ${opencodeBin}`)

  try {
    // ---------------------------------------------------------------- packaging
    const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout,
    }).trim()
    const tarball = join(packDir, packOutput.split("\n").pop().trim())
    record("npm pack produces a tarball", existsSync(tarball), tarball)

    const contents = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    record("tarball ships the built entry point", contents.includes("package/dist/checkpoint-orchestrator.js"))
    record(
      "tarball contains no database, node_modules or tests",
      !/\.db(-wal|-shm)?$|node_modules\/|package\/tests\//.test(contents),
    )

    // ---------------------------------------------------------- clean consumer
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "co-integration", version: "1.0.0", type: "module" }, null, 2))
    execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: project, encoding: "utf8", timeout })
    const local = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    const installed = JSON.parse(readFileSync(join(project, "node_modules/@gitdamnit/checkpoint-orchestrator/package.json"), "utf8"))
    record("installed package version matches the checkout", installed.version === local.version, installed.version)

    // OpenCode resolves a plugin given by *package name* by installing it from the
    // npm registry, which for an unreleased build means the old published version.
    // Local discovery from `.opencode/plugins/` loads the installed artifact, so the
    // shim below re-exports the package that npm actually installed here.
    //
    // The database location is supplied through the documented environment
    // override, which also exercises that code path.
    const pluginsDir = join(project, ".opencode", "plugins")
    mkdirSync(pluginsDir, { recursive: true })
    const shimMarker = join(workRoot, "shim-imported.json")
    writeFileSync(
      join(pluginsDir, "checkpoint-orchestrator.js"),
      [
        'import { writeFileSync } from "node:fs"',
        'import pkg from "@gitdamnit/checkpoint-orchestrator"',
        `writeFileSync(${JSON.stringify(shimMarker)}, JSON.stringify({ id: pkg?.id ?? null, cwd: process.cwd(), argv: process.argv.slice(0, 3) }))`,
        "export default pkg",
        "",
      ].join("\n"),
    )
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))

    const env = { CHECKPOINT_ORCHESTRATOR_DB: dbPath }

    // ------------------------------------------------------- runtime: load only
    const versions = run(["--version"])
    record("opencode CLI is available", versions.status === 0, versions.output.trim().split("\n")[0])

    // Unique per run: reusing a session id resumes a session bound to a previous
    // (now deleted) project directory, which stops the current location's plugins
    // from loading.
    const runID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const sessionA = `ses_it_alpha_${runID}`
    const sessionB = `ses_it_beta_${runID}`

    const loadAttempt = runUntil(
      ["run", "--standalone", "--print-logs", "--auto", "-s", sessionA, "Reply with the single word: ready"],
      { cwd: project, env },
      () => existsSync(dbPath),
      "plugin load",
    )
    const load = loadAttempt.result
    const dbCreated = existsSync(dbPath)
    const attempted = /loading plugin/.test(load.output)
    const loadFailed = /failed to load plugin/i.test(load.output)

    if (loadFailed) {
      // A real, deterministic loader error: the module was found and rejected.
      record("plugin module loads in the runtime", false, "loader reported a failure")
    } else if (dbCreated || attempted) {
      record("plugin loads inside the OpenCode runtime and opens its database", dbCreated, dbCreated ? `${dbPath} (attempt ${loadAttempt.attempts})` : "attempted but no database")
      record("the location's plugin was enumerated", attempted, "loader log line")
    } else {
      advisory(
        "plugin activation observed in this environment",
        false,
        `the loader never enumerated a plugin for the project after ${loadAttempt.attempts} attempts`,
      )
      record("plugin loads inside the OpenCode runtime and opens its database", false, "not observable in this environment")
    }
    if (existsSync(shimMarker)) {
      const info = JSON.parse(readFileSync(shimMarker, "utf8"))
      record("the packaged plugin was imported and exported a valid V2 definition", info.id === "gitdamnit.checkpoint-orchestrator", `id=${info.id}`)
    } else {
      advisory("shim module imported by the runtime", false, "shim was never imported")
    }
    if (!dbCreated) {
      const relevant = load.output
        .split("\n")
        .filter((line) => /plugin|level=(WARN|ERROR)/i.test(line))
        .slice(0, 12)
      console.log("  --- loader diagnostics ---")
      for (const line of relevant) console.log(`  ${line}`)
      console.log(`  exit status: ${load.status}`)
    }
    if (existsSync(dbPath)) {
      const probe = new DatabaseSync(dbPath)
      const mode = probe.prepare("PRAGMA journal_mode").get()
      record("WAL journalling in the real runtime", Object.values(mode)[0] === "wal", String(Object.values(mode)[0]))
      const userVersion = Number(Object.values(probe.prepare("PRAGMA user_version").get())[0])
      record("schema is migrated on first load", userVersion >= 1, `user_version=${userVersion}`)
      const tables = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name)
      record(
        "all expected tables exist",
        ["checkpoints", "migrations", "projects", "session_runtime", "sessions", "snapshots"].every((t) =>
          tables.includes(t),
        ),
        tables.join(","),
      )
      const perms = statSync(dbPath).mode & 0o777
      record("database file is owner-only", perms === 0o600, perms.toString(8))
      probe.close()
    }

    // ------------------------------------------------- runtime: exercise tools
    const saveAttempt = runUntil(
      [
        "run",
        "--standalone",
        "--auto",
        "-s",
        sessionA,
        "Use the checkpoint_save tool with these exact arguments: " +
          '{"title":"runtime-probe","objective":"prove the plugin works","status":"in_progress",' +
          '"completedSteps":["packaged"],"nextSteps":["verify"],"snapshotName":"runtime-snapshot"}. ' +
          "Then call checkpoint_status and print the raw JSON it returns.",
      ],
      { cwd: project, env },
      () => {
        if (!existsSync(dbPath)) return false
        try {
          const probe = new DatabaseSync(dbPath)
          const row = probe.prepare("SELECT COUNT(*) AS c FROM checkpoints WHERE session_id = ?").get(sessionA)
          probe.close()
          return Number(row.c) > 0
        } catch {
          return false
        }
      },
      "tool invocation",
    )
    const save = saveAttempt.result

    if (!existsSync(dbPath)) {
      advisory("tool invocation through a real model turn", false, "no database was created, so the tools were not exercised")
      console.log(`\n${results.length - failures}/${results.length} integration checks passed (${advisories} advisory)`)
      if (failures > 0) process.exitCode = 1
      return
    }

    const db = existsSync(dbPath) ? new DatabaseSync(dbPath) : null
    const row = db
      ? db
          .prepare("SELECT title, objective, status, completed_steps, next_steps, synthesized FROM checkpoints WHERE session_id = ?")
          .get(sessionA)
      : undefined
    record("the model invoked checkpoint_save", row !== undefined, row ? String(row.title) : "no row for session A")
    if (row) {
      record("saved fields round-tripped through SQLite", row.title === "runtime-probe" && row.status === "in_progress")
      record("completed steps were stored as JSON", String(row.completed_steps).includes("packaged"), String(row.completed_steps))
      record("the checkpoint is marked as real, not synthesized", Number(row.synthesized) === 0)
    }
    const snapshot = db ? db.prepare("SELECT name, kind FROM snapshots WHERE session_id = ?").get(sessionA) : undefined
    record("named snapshot recorded", snapshot?.name === "runtime-snapshot", snapshot ? String(snapshot.name) : "none")
    record("checkpoint_status reported the checkpoint", /"exists"\s*:\s*true/.test(save.stdout), "")

    // ------------------------------------------------ isolation in the runtime
    const other = run(
      ["run", "--standalone", "--auto", "-s", sessionB, "Call the checkpoint_status tool and print the raw JSON it returns."],
      { cwd: project, env },
    )
    record(
      "a different session sees no checkpoint (isolation)",
      /"exists"\s*:\s*false/.test(other.stdout),
      other.stdout.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "",
    )
    const leaked = db ? db.prepare("SELECT COUNT(*) AS c FROM checkpoints WHERE session_id = ?").get(sessionB) : { c: -1 }
    record("no checkpoint row exists for the other session", Number(leaked.c) === 0)

    // ---------------------------------------- persistence across a new process
    const resume = run(
      ["run", "--standalone", "--auto", "-s", sessionA, "Call the checkpoint_status tool and print the raw JSON it returns."],
      { cwd: project, env },
    )
    record("state survives a fresh process for the same session", /"exists"\s*:\s*true/.test(resume.stdout))
    record("the resumed session is the one that saved", resume.stdout.includes("runtime-probe"))

    if (db) {
      const integrity = db.prepare("PRAGMA integrity_check").get()
      record("database integrity after real use", Object.values(integrity)[0] === "ok", String(Object.values(integrity)[0]))
      db.close()
    }
  } catch (error) {
    record("integration run completed without an exception", false, String(error?.message ?? error))
  } finally {
    const keep = process.env.KEEP_INTEGRATION_DIR === "1"
    if (!keep) rmSync(workRoot, { recursive: true, force: true })
    else console.log(`kept: ${workRoot}`)
  }

  console.log(`\n${results.length - failures}/${results.length} integration checks passed (${advisories} advisory)`)
  if (failures > 0) {
    console.error(`${failures} integration check(s) failed`)
    process.exitCode = 1
  }
}

main()
