# Runtime verification

Evidence that this plugin works in a **real OpenCode V2 runtime**, not just under
`tsc` and `node:test`.

## Environment

| Component | Value |
|---|---|
| OpenCode CLI | `opencode v2.0.21` |
| Runtime | Bun **1.4.2** (embedded in the OpenCode binary) |
| Node compatibility inside that runtime | 26.3.0 |
| SQLite inside that runtime | 3.53.2 |
| Host Node (tests/tooling) | 22.23.2 (SQLite 3.51.3) |
| OS | Linux Mint 22.3, x86_64, ext4 |

The CLI is a Bun single-file executable, which is why `node:sqlite` availability
was checked in *that* runtime rather than only in Node.

## Docker Plugin Test Lab

The separate lab ran this plugin, staged → packed → installed from commit
`bedc14b` (`2.0.0-dev.1`, clean worktree), in rootless Docker with a disposable
project and an offline mock provider. Result: **145/145** lab checks across
runtime loading (5 configs), functional tests, the model-request path,
combined-compatibility, the 6-load-order matrix plus a duplicate, security,
concurrency/crash consistency, failure isolation, and the live automatic-trigger
suites. All eight tools registered alone, with either sibling, and with all three
installed together. Its own copy of this repository's suites also ran inside the
image: **83/83** (`isolation` + `legacy` = 29; `store` + `service` + `unit` = 54).
`plugin.test.js` and `interop.test.js` were not run there because they resolve
`@opencode/plugin` from a full workspace; the lab's runtime/matrix/trigger suites
cover their subject matter, and both run in this repository (30 tests).

The lab's reports were not modified by this repository; see the lab's
`reports/rc-verification.md` and `reports/rc-upstream-tests.md`. The hardening in
`2.0.0-dev.2` changes storage internals only (migration, project identity,
first-open and legacy-import concurrency), which the matrix and tool-registration
checks do not exercise.

## What was checked, and how

### 1. Packaging

`npm pack` was run against this branch and the resulting tarball inspected:

```
PASS  npm pack produces a tarball
PASS  tarball ships the built entry point   (package/dist/checkpoint-orchestrator.js)
PASS  tarball contains no database, node_modules or tests
PASS  installed package version 2.0.0-dev.1
```

The tarball was installed into a clean throwaway project, so the artifact under
test is the published shape, not a workspace checkout.

### 2. Driver conformance inside the real runtime

The same conformance probe (`tests/driver-conformance.cjs`) was executed by a
plugin in both runtimes. Both report identical capabilities:

| Capability | Node 22.23.2 | Bun 1.4.2 (OpenCode) |
|---|---|---|
| `node:sqlite` available | yes | yes |
| WAL + `synchronous=NORMAL` | yes | yes |
| Foreign keys enforced, cascade | yes | yes |
| Transactions, savepoints, rollback | yes | yes |
| `integrity_check`, `foreign_key_check` | yes | yes |
| Concurrent handles / lock contention | yes | yes |
| `json_extract` | yes | yes |

### 3. Plugin load and tool execution in a live session

The built plugin was loaded by a running OpenCode service and all eight tools
were invoked through the real tool bridge. Verbatim results:

```
checkpoint_status (before)
{ "exists": false, "sessionID": "ses_ec08…", "projectID": "debee94c…", "snapshotCount": 0 }

checkpoint_save { title, objective, status:"in_progress", completedSteps, nextSteps, snapshotName:"runtime-snapshot" }
{ "version": 3, "task": { "title": "runtime-verification", "status": "in_progress" }, … }

checkpoint_status (after)
{ "exists": true, "completedSteps": 1, "nextSteps": 2, "blockers": 0, "snapshotCount": 1 }

checkpoint_list
{ "count": 1, "snapshots": [ { "name": "runtime-snapshot", "kind": "named", "title": "runtime-verification" } ] }

checkpoint_load_snapshot { name: "runtime-snapshot" }        -> full payload
checkpoint_load_snapshot { name: "does-not-exist" }
{ "error": "Snapshot not found", "available": ["runtime-snapshot"] }

checkpoint_save { status:"blocked", blockers:["deliberate divergence"] }
checkpoint_restore_snapshot { name: "runtime-snapshot" }
{ "restored": true, "undoSnapshot": "pre-restore-1792080682366" }
checkpoint_load   -> status back to "in_progress", blockers [], completedSteps restored
checkpoint_list   -> pre-restore (newest), auto (the divergent save), named (restoredAt set)
checkpoint_migrate {}
{ "adopted": false, "legacyPresent": false, "alreadyImported": false, "warnings": [] }
checkpoint_clear
{ "cleared": true, "checkpoints": 1, "snapshots": 3, "handoffRemoved": true }
```

### 4. Database state, read directly

Read with an independent `node:sqlite` connection while the service was running:

```
journal_mode     wal
user_version     1
integrity_check  ok
foreign_key_check 0 violations
tables           checkpoints, migrations, projects, session_runtime, sessions, snapshots
projects         [{ id: debee94c…, directory: /home/evan/Projects/checkpoint-orchestrator }]
sessions         [{ id: ses_ec08…, project_id: debee94c…, parent_id: null }]
checkpoints      [{ session_id: ses_ec08…, title: runtime-verification, synthesized: 0 }]
snapshots        [named runtime-snapshot, auto-auto-…, pre-restore-…]
session_runtime  [{ session_id: ses_ec08…, messages_since_save: 0 }]
```

Every row belongs to the session that created it: one session, one checkpoint,
its own snapshots. File permissions were `0600`.

Note that `directory` is the *canonical* project root (the main checkout), while
the plugin instance was loaded from a worktree — correct project identity, and
the reason handoff files land in the canonical root.

## Reproducing this

```bash
npm run build
# In any project that should dogfood this build:
mkdir -p .opencode/plugins
ln -sf "$PWD/dist/checkpoint-orchestrator.js" .opencode/plugins/checkpoint-orchestrator.js
# Restart OpenCode (or let the plugin watcher pick it up) and call the tools.
```

`tests/integration/opencode-runtime.mjs` (`npm run test:opencode`) automates the
packaging and installation half of this. Its runtime half is best-effort; see the
observations below.

## Runtime observations and limitations

These were found by experiment against 2.0.21. They are properties of the host,
not of this plugin, but they affect how it is tested and installed.

1. **Plugin activation is asynchronous.** A short `opencode run` can complete its
   turn before the location's plugin host has enumerated plugins. When that
   happens the run simply has no plugin tools; there is no error. The integration
   script retries and reports this as advisory rather than as a defect.

2. **A package name resolves from the npm registry, not the local checkout.**
   Configuring `plugins: ["@gitdamnit/checkpoint-orchestrator"]` makes OpenCode
   install `@latest` from npm into `~/.cache/opencode/npm/…`. Testing an
   unreleased build that way loads the *published* version. Use a local
   `.opencode/plugins/` entry, as above.

3. **Filesystem paths in `plugins` did not load.** Relative, absolute and
   `file://` entries (both the string and `{"package": …}` object forms) were not
   enumerated for the location in any attempt, while a bare package name and a
   `.opencode/plugins/` file both were.

4. **Nested `opencode` invocations inherit `OPENCODE_SESSION_ID`.** In an agent
   environment that exports it, a spawned `opencode run -s <other>` can resume
   the outer session in the outer directory. The integration script strips
   `OPENCODE*` variables from the child environment.

5. **A piped stdin changes behaviour.** With `spawnSync` defaults (stdin piped),
   plugins were never enumerated; with `stdio: ["inherit", "pipe", "pipe"]` they
   were. The script inherits stdin.

6. **`opencode serve` requires authentication** (it prints a `server password` on
   startup). The bearer/`x-opencode-password`/Basic variants tried here were all
   rejected, so the automated test drives the CLI rather than the HTTP API.
