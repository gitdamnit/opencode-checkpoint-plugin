![gitdamnit](gitdamnit.jpg)

# @gitdamnit/checkpoint-orchestrator

[![CI](https://github.com/gitdamnit/opencode-checkpoint-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/gitdamnit/opencode-checkpoint-plugin/actions/workflows/ci.yml)

Failure-resilient, **session-isolated** checkpointing for OpenCode. Task state is
persisted in SQLite so the next model, provider, or session can pick up exactly
where the last one left off.

> **Status: v2.0.0 development line.** This is a breaking release: storage moved
> from project-level JSON to a SQLite database, the plugin API moved from
> `@opencode-ai/plugin` (V1) to `@opencode/plugin` (V2), and checkpoints are now
> scoped to a session. The published `1.0.1` release is unaffected. See
> [docs/MIGRATION.md](docs/MIGRATION.md) for the upgrade path.

## Why

OpenCode's own persistence covers the conversation. It does not cover *task
state*: what you are doing, what is done, what is next, and what is blocking.
That is what this plugin stores, and it stores it per session so that two
sessions working in the same repository can never overwrite or inherit each
other's state.

## Requirements

| Component | Requirement | Verified with |
|---|---|---|
| OpenCode | V2 (plugin API `@opencode/plugin` v2) | `opencode` 2.0.21 |
| Plugin SDK | `@opencode/plugin` 2.x | 2.0.21 (pinned) |
| SQLite driver | `node:sqlite` — built in to Node ≥ 22.13 and Bun ≥ 1.4 | Node 22.23.2, Bun 1.4.2 |
| Node (for tests/tooling) | ≥ 22.13 | 22.23.2 |

`node:sqlite` exists from Node 22.5, but only from **22.13.0 / 23.4.0** is it
available without `--experimental-sqlite`, which is why that is the floor in
`engines.node`. An older runtime needs the flag; it cannot run the storage layer
as-is. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

No native modules are installed, so there is nothing to compile and no ABI to
match. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the driver decision
and the evidence behind it.

## Install

```bash
npm install @gitdamnit/checkpoint-orchestrator
```

Register it in `opencode.json(c)` — note the V2 key is `plugins`, and each entry
is a package name or an object with `options`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@gitdamnit/checkpoint-orchestrator"]
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "@gitdamnit/checkpoint-orchestrator",
      "options": {
        "historyLimit": 20,
        "autosaveEvery": 5,
        "handoff": true
      }
    }
  ]
}
```

Local development checkouts are loaded from `.opencode/plugins/`.

## Tools

| Tool | Description |
|---|---|
| `checkpoint_save` | Save or update this session's state. Fields are deep-merged, so a partial update never clobbers stored data. Optional `snapshotName` tags the save. |
| `checkpoint_load` | Load this session's full current state. |
| `checkpoint_status` | Whether a checkpoint exists, when it changed, status, step counts, blocker count, snapshot count, and whether it is a synthesized placeholder. |
| `checkpoint_clear` | Delete this session's state, snapshots, counters and handoff file. Other sessions are untouched. |
| `checkpoint_list` | List this session's snapshots newest first, with name, kind, timestamp, title and status. |
| `checkpoint_load_snapshot` | Read one named snapshot. Read-only. |
| `checkpoint_restore_snapshot` | Promote a named snapshot to live state; the previous state is kept as a `pre-restore-*` undo snapshot. |
| `checkpoint_migrate` | Report pre-SQLite JSON data for this project, and optionally adopt it into the calling session. |

Every tool takes the calling session from the OpenCode tool context, never from
the plugin's own working directory, and every query is scoped by session id.

## Session isolation

This is the core fix in v2.0.0.

* Each session has exactly one live checkpoint row, keyed by `session_id`.
* Snapshots, counters and dedup hashes are per session.
* A session can never read, write, clear, or restore another session's state.
* Child sessions do **not** inherit a parent's checkpoint. Inheritance, if you
  want it, is an explicit `checkpoint_migrate --adopt` style operation.
* Session switching does not reset another session's message counter.
* Switching model or provider mid-session preserves that session's state
  because nothing is keyed on the model.

Verified by `tests/isolation.test.js` (2, 5 and 25 concurrent sessions, multiple
projects, child sessions, concurrent writers, and plugin restart).

## Storage

One SQLite database, outside any working tree:

| Platform | Default location |
|---|---|
| Linux | `$XDG_DATA_HOME/opencode/checkpoint-orchestrator/checkpoints.db` (or `~/.local/share/...`) |
| macOS | `~/Library/Application Support/opencode/checkpoint-orchestrator/checkpoints.db` |
| Windows | `%APPDATA%\opencode\checkpoint-orchestrator\checkpoints.db` |

Override with the `databasePath` plugin option or the
`CHECKPOINT_ORCHESTRATOR_DB` environment variable. The database directory is
created with `0700` and the database file with `0600` permissions.

Tables: `projects`, `sessions`, `checkpoints`, `snapshots`, `session_runtime`,
`migrations`. The schema is versioned in `PRAGMA user_version` and migrated
forward — the whole upgrade runs in one `BEGIN IMMEDIATE` transaction that
re-reads the version after taking the write lock, so several processes may open a
brand-new database at the same instant without racing `CREATE TABLE`. WAL
journaling and a busy timeout are enabled, foreign keys are enforced, and all
multi-table writes are atomic.

### Backup and recovery

The database is a normal SQLite file; copy it while a writer is idle, or use
SQLite's own API rather than a raw file copy of a live WAL database:

```bash
# Consistent snapshot without stopping OpenCode (Node ≥ 22.13):
node -e '
  const { DatabaseSync } = require("node:sqlite")
  const src = new DatabaseSync(process.env.HOME + "/.local/share/opencode/checkpoint-orchestrator/checkpoints.db")
  src.backup("checkpoints.backup.db").then(() => { src.close(); console.log("backup written") })
'
```

The `-wal` and `-shm` files are part of the database: never copy `checkpoints.db`
alone while it is in use. Recovery options, in order of preference:

1. `checkpoint_load_snapshot` / `checkpoint_restore_snapshot` — per-session undo
   straight from the live database. A restore first captures the current state as
   a `pre-restore-<timestamp>` snapshot, and pruning always retains the newest one.
2. Restore a `checkpoints.backup.db` file over the live database while OpenCode is
   stopped.
3. `PRAGMA integrity_check` / `PRAGMA foreign_key_check` report corruption; the
   plugin only logs the result and never rewrites the file.

An unknown *newer* `user_version` is refused rather than used, so a database
written by a future release is never silently downgraded. Git That Shit
intentionally excludes live `.sqlite`/`.db`/`-wal`/`-shm` files, so the backup
above (or the handoff export) is the supported way to carry state off the machine.

`handoff.md` is no longer authoritative. A derived, per-session
`handoff-<sessionId>.md` is written under
`.opencode/state/checkpoint-orchestrator/` — this plugin's own namespace, so a
co-installed plugin sharing `.opencode/` can never collide with it. The export
carries the marker `checkpoint-orchestrator/handoff@1` and can be regenerated
from the database at any time.

## Automatic persistence

Three independent triggers, all session-scoped:

| Trigger | Fires when | Behaviour |
|---|---|---|
| **A — context compaction** | OpenCode compacts a session | Persists the session's state and injects it into the compaction request so the summary carries it forward. If nothing was ever saved, records a clearly marked **synthesized placeholder** instead of inventing progress. |
| **B — periodic** | Every 5th admitted user prompt (`autosaveEvery`) | Persists the session's state. Unchanged state is not rewritten, does not move `updatedAt`, and does not create a snapshot. |
| **C — explicit** | The agent calls `checkpoint_save` | Primary path. Full or partial state, optional named snapshot. |

Injected context is deduplicated per session by content hash, and synthesized
placeholders are never injected.

## Plugin options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `databasePath` | string | platform default | Database file location. |
| `historyLimit` | number | `10` | Snapshots retained per session. The newest `pre-restore` undo snapshot is always retained, even beyond the limit. |
| `autosaveEvery` | number \| `false` | `5` | User prompts between periodic saves. `false` or `0` disables trigger B. |
| `handoff` | boolean | `true` | Write the derived per-session handoff file. |
| `handoffDir` | string | `.opencode/state/checkpoint-orchestrator` | Relative directory for handoff files. Absolute and parent-escaping paths are rejected. |
| `maxInjectionChars` | number | `20000` | Cap on injected checkpoint JSON. |
| `legacyImport` | `"namespace"` \| `"off"` | `"namespace"` | Import pre-SQLite JSON into a legacy namespace on startup. |

## Independence from the other toolkit plugins

This plugin is designed to be installed alone, alongside either of the other
`@gitdamnit` toolkit plugins, or with both.

* Runtime dependency: `@opencode/plugin` only. No plugin-to-plugin imports, no
  shared framework, no plugin manager, no mandatory shared configuration.
* It never reads or writes another plugin's storage, and never copies a live
  SQLite database.
* Correctness never depends on hook execution order. Its `prompt` hook only
  observes, and its `compaction` hook only *appends* to the compaction context —
  it never replaces another plugin's contribution or relies on one.
* A companion that is missing, disabled, failing or older changes nothing about
  how this plugin behaves.
* The only optional interoperability offered is a versioned, read-only handoff
  export; see [docs/INDEPENDENCE.md](docs/INDEPENDENCE.md).

## Upgrading from 1.x

1. Install this version.
2. Change `plugin` to `plugins` in your OpenCode configuration.
3. Restart OpenCode. On first load, any `.opencode/state/checkpoint.json` that
   matches this plugin's schema is backed up (into
   `.opencode/state/checkpoint-orchestrator/legacy-backup/`) and imported into a
   clearly named legacy namespace — **not** into any live session. A file that is
   not this plugin's data is reported and left untouched.
4. Run `checkpoint_migrate` to see what was found, then
   `checkpoint_migrate { "adopt": true }` in the session that should continue
   that work.

Old data is never deleted, and the import never runs twice.

## V1 support

Not maintained. This package now targets the V2 plugin API only, and a single
implementation cannot serve both APIs safely for session-scoped storage because
V1 has no per-session tool context. V1 users should stay on the `1.0.1` release
line or upgrade OpenCode. Details in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test              # source-level suites (node:test) — 119 tests
npm run test:legacy   # the pre-2.0 V1 suites, kept as a reference
npm run test:all      # both together
npm run test:opencode # verifies packaging, and probes a real OpenCode runtime
```

`tests/` exercises the built output in `dist/`, not a reimplementation. It
covers the SQLite driver, the store, the session-scoped service, isolation,
legacy migration and the real V2 plugin wiring (tools, hooks, events, cleanup).

> **On the test counts.** `npm test` (119 tests) is the coverage of *this* code:
> every suite imports the compiled `dist/` output or drives the real plugin entry
> point. `npm run test:legacy` runs the historical 979 V1 assertions, which
> re-implement the old JSON logic inside the test files and therefore pass without
> exercising the shipped plugin. They are kept as a V1 behaviour reference, not as
> evidence about the release; the combined figure (1,098) is only meaningful as
> "both suites were executed".

To dogfood a local build before publishing, link it into the project you are
working in and restart OpenCode:

```bash
mkdir -p .opencode/plugins
ln -sf "$PWD/dist/checkpoint-orchestrator.js" .opencode/plugins/checkpoint-orchestrator.js
```

`docs/RUNTIME-VERIFICATION.md` records what has been verified against a real
OpenCode 2.0.21 / Bun 1.4.2 runtime, including the host behaviours that affect
plugin loading.

## Known limitations

* `node:sqlite` is still marked experimental in Node, so a warning is printed
  under plain Node. Bun's implementation (the runtime OpenCode uses) does not
  warn. It is unflagged from Node 22.13.0 / 23.4.0.
* A synthesized placeholder is created only when compaction happens with no
  prior checkpoint. Later real state replaces it.
* Two processes configured with different `historyLimit` values will prune to
  their own limits; the last writer's limit wins for that session.
* `checkpoint_clear` intentionally does not delete sibling sessions' data. There
  is no "clear everything" tool.
* After `checkpoint_clear`, a later compaction records a new **synthesized
  placeholder** — clearly marked, and never injected into the summary — because
  the plugin cannot distinguish "cleared" from "never saved" without keeping a
  tombstone. It contains no task progress.
* Session deletion in OpenCode does not delete stored checkpoints: they are kept
  so that no committed state is lost silently.
* If a host reports two project ids for the same canonical directory, each id
  keeps its own session rows. Storage stays usable (migration 2 removed the
  `UNIQUE(directory)` constraint), but legacy JSON in that directory is imported
  once per project id, into separate `legacy::<projectID>` namespaces.
* Independence guarantees, the test matrix, and behaviour with companion plugins
  absent or failing are documented in
  [docs/INDEPENDENCE.md](docs/INDEPENDENCE.md). A Docker Plugin Test Lab run
  against this development line registered all eight checkpoint tools alone, with
  each sibling plugin, and with all three installed together, in every load
  order; see [docs/RUNTIME-VERIFICATION.md](docs/RUNTIME-VERIFICATION.md) for the
  exact commit that was measured.

## License

MIT — see [LICENSE](LICENSE).
