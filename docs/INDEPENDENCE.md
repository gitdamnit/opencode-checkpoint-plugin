# Independence and interoperability

This plugin is one of three independently developed OpenCode V2 plugins
(Git That Shit, Stranger Danger, Checkpoint Orchestrator). There is no shared
framework, no plugin manager, and no common runtime dependency. Each plugin is
installable, runnable, maintainable and releasable on its own.

This document is the contract for **Checkpoint Orchestrator**. It states what
this plugin owns, what it touches, and what it guarantees when its companions are
absent, disabled, failing, or older than it is.

## 1. Responsibility

Task continuity, and nothing else.

| Owns | Does not do |
|---|---|
| Structured task progress per session | Security inspection or policy enforcement |
| Session-isolated checkpoint records | Filesystem backup or shadow repositories |
| Handoff and continuation context | Sanitising inputs for other plugins |
| Its own persistence and recovery | Anything that requires a companion plugin |

## 2. Installing it alone

This is the supported default. Nothing in the plugin requires a companion to
start, to register tools, or to persist state.

```jsonc
{
  "plugins": ["@gitdamnit/checkpoint-orchestrator"]
}
```

A local development build is loaded from `.opencode/plugins/` (see the README).
Runtime dependency: `@opencode/plugin` only. There is no optional peer and no
plugin-to-plugin import.

## 3. Configuration namespace

| Surface | Namespace | Notes |
|---|---|---|
| Plugin id | `gitdamnit.checkpoint-orchestrator` | Used by the host for status and diagnostics |
| Options | `ctx.options` | Passed per plugin by the host; never a global config object |
| Environment | `CHECKPOINT_ORCHESTRATOR_DB` | Only used to override the database path |
| Tools | `checkpoint_*` | This plugin's reserved tool prefix |
| Log prefix | `[checkpoint-orchestrator]` | Distinguishable in shared logs |

No global mutable configuration is written, and this plugin never edits the
user's OpenCode configuration.

## 4. Owned storage

| Path | Ownership | Notes |
|---|---|---|
| `$XDG_DATA_HOME/opencode/checkpoint-orchestrator/checkpoints.db` (and macOS/Windows equivalents) | Exclusive | Directory `0700`, database `0600` |
| `<project>/.opencode/state/checkpoint-orchestrator/` | Exclusive | Derived per-session handoffs, migration backups |
| `<project>/.opencode/state/checkpoint.json` (+ history, handoff) | **Read-only** | The pre-2.0 format, read once for migration. Never written, never deleted. |

Rules this plugin follows:

* It writes only inside its own namespace and its own database directory.
* It never writes into another plugin's storage, and never copies a live SQLite
  database.
* Legacy files are copied, never moved or deleted. Copies go to
  `checkpoint-orchestrator/legacy-backup/`.
* A payload at the legacy path that does not match this plugin's schema is
  reported and skipped, so a same-named file owned by another tool can never be
  imported or overwritten by this plugin.

## 5. Hooks registered

| Hook | Kind | Effect |
|---|---|---|
| `session.hook("prompt")` | observation only | Increments this session's periodic-save counter |
| `session.hook("compaction")` | **additive** | Appends one text part to `event.system` containing this session's checkpoint |
| `event.subscribe()` | observation only | Re-persists state on `session.compacted` |

**Order independence.** Correctness never depends on when these hooks run
relative to another plugin's.

* The `prompt` hook only reads its event and writes to this plugin's own
  database. Nothing another plugin does can change its meaning.
* The `compaction` hook **appends** to `event.system` and never replaces it, never
  reads another plugin's contribution, and never rewrites the event. If a
  companion runs first, later or not at all, the outcome for this plugin is
  identical.
* This plugin never relies on arguments having been modified by another plugin,
  and never modifies arguments for anyone else. It registers no
  `tool.execute.before` hook at all.
* Neither hook requires another plugin to have initialised, and both are wrapped
  so they cannot throw into the host's hook chain.

"Compaction" refers to OpenCode's own context compaction, which is unrelated to
any snapshotting another plugin may perform.

## 6. When a companion is absent, disabled, failing or outdated

| Situation | This plugin's behaviour |
|---|---|
| No companion installed | Fully functional. This is the normal case. |
| Companion installed but disabled | Fully functional; no capability is looked for. |
| Companion fails at load or throws in a hook | Unaffected: tools work independently of hooks, and this plugin's hooks are defensive. |
| Companion writes malformed data | Never read. This plugin consumes no companion storage. |
| Companion is an older or newer version | No effect: there is no version negotiation because there is no coupling. |

There is no optional interface this plugin *requires*, and therefore no missing
capability it must degrade around.

## 7. Optional interoperability

Deliberately minimal, because cross-plugin integration must be justified by a
concrete benefit rather than speculative symmetry.

**Offered:** a versioned, read-only export.

* `<project>/.opencode/state/checkpoint-orchestrator/handoff-<sessionId>.md`,
  stamped with the marker `checkpoint-orchestrator/handoff@1`.
* It is derived from committed database rows, regenerable at any time, and safe
  for another tool or plugin to read. It is never read back as state, so a
  consumer cannot corrupt this plugin by editing it.
* Consumers must treat an unknown `@N` marker as "do not parse", and must not
  assume the file exists.

**Not implemented, on purpose:** no cross-plugin calls, no shared database, no
shared configuration, and no consumption of another plugin's snapshot metadata.
Nothing in this plugin's operation depends on any of it, so adding it now would
be speculative.

**Rule for consumers:** use the export or a tool call. Do not copy
`checkpoints.db`: SQLite's WAL means a naive file copy can be inconsistent, and
the database is this plugin's private storage.

### Backup interoperability with Git That Shit

Git That Shit deliberately excludes live `.sqlite`, `.db`, `-wal` and `-shm`
files, so it will never commit this plugin's database and this plugin must not
depend on it for durability. The supported interface already exists and needs no
new code:

1. **Off-machine state**: the versioned `handoff-<sessionId>.md` export, or
   `checkpoint_load` / `checkpoint_list` through the tool API.
2. **Whole-database copy**: `DatabaseSync.backup()` (Node ≥ 22.13) or a copy taken
   while OpenCode is stopped. This is documented for users in
   [MIGRATION.md](MIGRATION.md#6-backing-up-and-recovering-the-database).

A `checkpoint_backup` tool that shells out to a configured Git That Shit
command would add a mandatory cross-plugin dependency for no capability this
plugin does not already offer, so it is deliberately not implemented. If a future
release wants one-command export, the smallest useful shape is a tool that writes
a `DatabaseSync.backup()` file to a caller-supplied path and returns it — no
knowledge of the consumer, no coupling.

## 8. Concurrency and session isolation

* Every checkpoint, snapshot, counter and dedup hash is scoped by session id.
  Two sessions in one project cannot read, overwrite, clear or restore each
  other's state.
* Concurrent writers are safe: read-merge-write is a single transaction, WAL plus
  a busy timeout handles contention, and multi-process access is tested with four
  writers and a `SIGKILL` crash test.
* Handoff exports are per session and atomically replaced, so concurrent sessions
  cannot collide.
* Process-local state is limited to a snapshot-name sequence used to keep names
  unique. It is not shared with, or visible to, any other plugin.
* Reload is safe: cleanup aborts the event subscription and closes the database;
  committed state is reloaded by the next instance. Two instances in one process
  share the database safely.

## 9. Test coverage for these guarantees

`tests/interop.test.js` states and checks them, using a stand-in "foreign" plugin
that registers its own tools, hooks and storage in the same host:

1. works with no other plugin installed
2. declares no dependency on another toolkit plugin (dependency and source audit)
3. needs no host domain beyond `app`, `location`, `options`, `tool`, `session`, `event` (enforced with a throwing proxy)
4. coexists with a foreign plugin in **either** registration order, with both
   compaction contributions surviving and no hook throwing
5. unaffected by a foreign plugin whose hooks throw, under both an isolating and
   a stop-at-first-error host
6. unaffected by a foreign plugin that fails to load
7. storage ownership is disjoint: the foreign file is byte-identical afterwards
   and every file this plugin writes is inside its own namespace
8. five simultaneous sessions stay isolated while a companion is active
9. cleanup and reload affect only this plugin
10. two instances loaded at once share one database safely
11. a tool call without a session id is refused
12. loads with an empty or absent options object

## 10. Integration matrix

The sibling plugins were not importable from this repository, so the full matrix
was executed in the separate **Docker Plugin Test Lab** (rootless, disposable
project, offline mock provider) rather than in this checkout. That lab run is
against commit `bedc14b` (`2.0.0-dev.1`) of this plugin; the hardening in
`2.0.0-dev.2` changes storage internals only and does not alter the tool surface
or the hook contract the matrix exercises.

| Configuration | Expected | Status |
|---|---|---|
| Checkpoint Orchestrator alone | Fully functional | **Verified** (lab: 145/145 checks, all 8 tools registered) |
| A foreign plugin stand-in + this plugin | Both functional | **Verified** here, both orders |
| Stranger Danger + Checkpoint Orchestrator | Both functional | **Verified** in the lab (`sd_cp_gts` order and others) |
| Git That Shit + Checkpoint Orchestrator | Both functional | **Verified** in the lab (`gts_cp_sd` and others) |
| All three plugins | All functional | **Verified** in the lab: all 6 load orders + a duplicate registration |

The lab also ran failure-isolation configurations (a companion failing first,
mid-order, and last) and confirmed the other plugins' tools and this one's remain
independently registered, with no errors. Evidence recorded by the lab (not
modified by this repository): `reports/rc-verification.md`,
`reports/runtime-all.json`, `reports/matrix-*.json`,
`reports/failure-isolation-*.json`.

Why an in-repo run is not possible: the sibling checkouts are not dependencies of
this package, and the matrix needs all three installed into a host at once.
Nothing in this plugin references them (dependency and source audit enforced by
`tests/interop.test.js`), so there is no inbound coupling to account for.

For the Docker Plugin Test Lab, this plugin needs no special support: install it
by package name or from a local path, give it an isolated `databasePath` or
`CHECKPOINT_ORCHESTRATOR_DB`, and use a disposable project directory. Assertions
can be made against the tools, the SQLite file, and the handoff export.
`docs/RUNTIME-VERIFICATION.md` records host behaviours the lab must account for
(asynchronous plugin activation, `OPENCODE_SESSION_ID` inheritance, and stdin
handling) as well as what has already been verified against a real runtime.

## 11. Known limitations

* The `prompt` hook is not an exactly-once boundary, so the periodic-save counter
  can over-count under retries. It is a safety net, not a ledger.
* Compaction injection depends on the host calling the hook; if it does not, task
  state is still persisted and available through `checkpoint_load`.
* A session can be deleted in OpenCode while its checkpoint rows are retained, so
  no committed state is lost silently. There is deliberately no "clear
  everything" tool.
* Two processes configured with different `historyLimit` values prune to their
  own limits.

## 12. Supported OpenCode versions

OpenCode V2 with the `@opencode/plugin` v2 API, pinned to `2.0.21` and verified
against runtime `opencode 2.0.21` (Bun 1.4.2). Node ≥ 22.13 is required for the
tests and tooling because `node:sqlite` is only unflagged from 22.13.0 / 23.4.0.
V1 is intentionally not supported; see `docs/COMPATIBILITY.md`.
