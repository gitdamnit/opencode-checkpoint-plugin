# Changelog

## [2.0.0-dev.2] — 2026-10-15

Persistence-integrity hardening found by the final SQLite audit. No tool-surface
change, no storage-format change beyond a forward-only schema migration, and no
change to the session-isolation contract.

### Fixed
- **Concurrent first-open of a new database no longer crashes.** Schema creation
  read `PRAGMA user_version` before taking the write lock, so several processes
  opening the same brand-new database at once all saw version 0 and all replayed
  `CREATE TABLE`. The loser died with `table projects already exists`, leaving that
  plugin instance permanently inert (`Checkpoint storage unavailable`). The whole
  upgrade now runs in one `BEGIN IMMEDIATE` transaction that re-reads the version
  after acquiring the lock, which also makes a multi-step upgrade all-or-nothing.
- **Two project ids may share one directory again.** `projects.directory` was
  `UNIQUE`, so a host reporting a second project id for the same canonical
  directory (a checkout plus a worktree of it, or a moved repository) made every
  write fail with `UNIQUE constraint failed: projects.directory`. Migration 2
  replaces the unique index with a plain one; the directory is metadata, and
  project identity is the id.
- **A write path can no longer overwrite the authoritative project directory.**
  When only the project id was known, the store recorded a placeholder row whose
  upsert rewrote the real `directory` with the project id string. The placeholder
  now never touches `directory`/`canonical`, and an authoritative `ensureSession`
  fills in the real value afterwards.
- **Concurrent legacy imports import exactly once.** The ledger check sat outside
  the write transaction, so two processes starting together could both import and
  duplicate the legacy snapshots. The check is now repeated inside the
  transaction; only the first committer imports.

### Changed
- `engines.node` raised from `>=22.5.0` to `>=22.13.0`. `node:sqlite` is only
  available without `--experimental-sqlite` from Node 22.13.0 / 23.4.0, so the
  previous floor claimed support for versions that cannot execute the storage
  layer.
- `npm run test:all` added: runs the source-level suites and the historical V1
  suites together, so the combined count is reproducible rather than implied.

### Added
- Regression tests for each fix: concurrent first-open with six processes,
  concurrent legacy import with six processes, migration from a real v1 schema
  with existing rows, duplicate project ids for one directory, write-path
  directory preservation, a schema-version/migration-list consistency guard, and
  a damaged or foreign file at the database path being refused rather than
  silently answered as "no checkpoint".
- `tests/fixtures/importer.mjs` and `tests/fixtures/schema-open.mjs`.

### Notes
- `checkpoint-orchestrator/handoff@1` and the seven preserved tools are unchanged.
- The 979 "legacy" tests are V1-algorithm conformance tests that re-implement the
  old logic in-file; they do not import the shipped plugin. They are kept as a V1
  reference under `npm run test:legacy`, but they are not coverage of this code —
  `npm test` (120 tests) is.

## [2.0.0-dev.1] — 2026-10-15

Independence and interoperability hardening. No change to the storage contract.

### Added
- `docs/INDEPENDENCE.md`: responsibilities, configuration and storage namespaces,
  registered hooks, order-independence guarantees, behaviour when companion
  plugins are absent, disabled, failing or outdated, the optional read-only
  interoperability contract, and the integration test matrix.
- `tests/interop.test.js` (12 tests): works alone; declares no dependency on
  another toolkit plugin; needs no host domain beyond the ones it documents
  (enforced with a throwing proxy); coexists with a foreign plugin in either
  registration order; is unaffected by a companion that throws or fails to load;
  keeps storage ownership disjoint; keeps five sessions isolated; survives
  cleanup, reload and double loading.
- `tests/helpers/fake-host.mjs`, a shared fake of the V2 host used by the wiring
  and interoperability suites.

### Changed
- Derived handoffs moved into this plugin's own namespace:
  `.opencode/state/checkpoint-orchestrator/handoff-<sessionId>.md`. It no longer
  writes directly into the shared `.opencode/state/` directory, and the export
  now carries the marker `checkpoint-orchestrator/handoff@1` so consumers can
  detect format changes.
- Migration backups are written to
  `.opencode/state/checkpoint-orchestrator/legacy-backup/` instead of beside the
  originals in the shared directory.
- `handoffDir` default updated to match; a relative override resolving to an
  empty path falls back to the namespaced default.

### Fixed
- A file at the legacy path that is not this plugin's data (for example another
  tool's `checkpoint.json`) is now detected, reported and skipped instead of
  being normalised into an empty checkpoint and imported. It is never overwritten
  and it no longer prevents a genuine legacy file from importing later.

## [2.0.0-dev.0] — 2026-10-15

Development release. Not published, not tagged. Breaking storage and plugin-API
change; `1.0.1` on `main` is unaffected.

### Added
- **SQLite persistence.** `node:sqlite` (built into Node ≥ 22.5 and Bun ≥ 1.4) is
  the authoritative store. No native module, no build step on install, no ABI to
  match. Schema: `projects`, `sessions`, `checkpoints`, `snapshots`,
  `session_runtime`, `migrations`, versioned in `PRAGMA user_version` and
  migrated forward in transactions.
- **Session isolation.** Every checkpoint, snapshot, counter and dedup hash is
  scoped by `session_id`. Sessions can no longer overwrite or inherit each
  other's state; child sessions inherit nothing implicitly.
- **Session-scoped tool context.** Tools resolve the calling session and project
  from the tool context instead of the plugin's working directory.
- **`checkpoint_migrate` tool** reporting legacy JSON data and adopting it into a
  session on explicit request.
- **Legacy JSON migration.** Transactional, idempotent via a ledger row, originals
  copied and never deleted, imported into a `legacy::<projectID>` namespace rather
  than into a live session. Legacy names and timestamps are preserved.
- **Synthesized-state tracking.** A compaction with no prior checkpoint records a
  clearly marked placeholder instead of inferring progress.
- **Per-session handoff files** at `.opencode/state/handoff-<sessionId>.md`,
  regenerable from the database.
- **Source-level test suite.** `node:test` suites that import the built `dist/`
  output and drive the real V2 plugin entry, plus a reproducible SQLite driver
  conformance probe.
- **Documentation:** `docs/ARCHITECTURE.md`, `docs/MIGRATION.md`,
  `docs/COMPATIBILITY.md`.

### Changed
- Plugin API migrated from V1 (`@opencode-ai/plugin`) to V2 (`@opencode/plugin`
  2.0.21): `Plugin.define({ id, setup })`, tools via `ctx.tool.transform`,
  `experimental.session.compacting` → `ctx.session.hook("compaction", …)`,
  `chat.message` → `ctx.session.hook("prompt", …)`, `event` →
  `ctx.event.subscribe()`, `ctx.directory` → `ctx.location`.
- OpenCode configuration key is now `plugins`, not `plugin`.
- A periodic save that produces no change no longer rewrites the checkpoint,
  moves `updatedAt`, or creates a snapshot.
- Snapshot pruning always retains the newest `pre-restore` undo snapshot.
- `checkpoint_clear` clears only the calling session.
- Handoff is generated per session and is never read back as state.
- `historyLimit` is configurable and applies per session.
- TypeScript build switched to `module`/`moduleResolution` `NodeNext` with
  explicit `.js` specifiers; `typecheck` script added.
- CI matrix moved to Node 22 and 24 (`node:sqlite` requires ≥ 22.5).
- Published artifact trimmed to `dist/` plus documentation and images; the
  database and development state are never packaged.

### Fixed
- Read-merge-write in `save()` is now a single `BEGIN IMMEDIATE` transaction; two
  writers on one session can no longer lose each other's fields.
- Automatic snapshot names are collision-free (`auto-<ms>-<pid><seq>`). The
  previous millisecond-only name collided under rapid writes and silently
  replaced history through the `(session_id, name)` constraint.
- A malformed or missing session id now throws instead of binding `NULL` and
  silently matching no rows.
- The handoff directory is created before writing, so the first export no longer
  fails silently.
- Legacy import rolls back completely on failure and can be retried.

### Removed
- `@opencode-ai/plugin` (V1 SDK) dependency.
- Project-level JSON as authoritative storage, and the project-wide
  `checkpoint.json` write path.

## [1.0.1] — 2026-05-13

Version-metadata-only release: `package.json` and the lockfile were bumped from
`1.0.0` to `1.0.1`. No code or behaviour change.

## [1.0.0] — 2026-05-13

### Added
- **Comprehensive test suite** (`tests/checkpoint_comprehensive.js`): 817 tests across 15 sections — property-based fuzz (100 iterations), filesystem lifecycle, recovery & resilience, atomic write verification, ring buffer boundary, deep merge combinatorial, sanitization, clamp boundary, schema versioning, timestamp format, stress (1000 merges + 200 file saves), extended security vectors, snapshot operations, handoff output structure, and checkpoint clear. Total test count: 979.
- **Hardening test suite** (`tests/checkpoint_hardening.js`): 77 tests covering security, fuzz, atomic integrity, stress, and edge cases.
- **GitHub Actions CI:** Runs lint, build, and 979 tests on Node 18/20/22.
- **ESLint config:** Flat config with TypeScript support.
- **TypeScript config:** `tsconfig.json` — build via `tsc` instead of raw `cpSync`.
- **Input size limit constants:** `MAX_STRING_LENGTH` (50KB), `MAX_ARRAY_ITEMS` (1000), `MAX_SANITIZED_LENGTH` (10KB).
- **Clamp helpers:** `clampString`, `clampArray` — enforce input size limits in `checkpoint_save` execute path.
- **Markdown sanitization:** `sanitizeForMarkdown`, `sanitizeArrayForMarkdown` — escapes `<`, `>`, and `"` in handoff output.

### Changed
- Build pipeline: replaced `fs.cpSync` with proper `tsc` compilation.
- `deepMerge` now uses optional chaining (`incoming?.task?.title`) and `??` nullish coalescing for all fields. Preserves empty strings, empty arrays, and `null` as valid values.
- `handoff.md` writing is now atomic — writes to temp file then renames into place.
- `checkpoint_clear` now deletes all three state files: `checkpoint.json`, `handoff.md`, `checkpoint-history.json`.
- Auto-save event handlers (`session.compacted`, `chat.message`) wrapped in `try/catch` — failures log but do not crash the plugin.
- Test script runs all three suites: smoke (85), hardening (77), and comprehensive (817).
- Version bumped to 1.0.0 — feature-complete, production-mature, with 979 tests, CI/CD, and full TypeScript build pipeline.
- `package.json` `files` now includes `plugins/`, `tests/`, and `gitdamnit.png` in published tarball.
- Removed `dist` from `.gitignore` so build output is properly versioned.

### Fixed
- TOCTOU race in `checkpoint_restore_snapshot` — snapshot restore now uses a single history read.
- Removed dead `isDirty` variable.
- Removed circular self-dependency `@gitdamnit/checkpoint-orchestrator: ^0.3.1` from `dependencies`.

### Security
- Input clamping on all `checkpoint_save` string and array parameters.
- Markdown escaping (`<`, `>`, `"`) in all handoff output fields.
- Prototype pollution resistance verified across 4 attack variants.

## [0.3.1] — 2026-05-08

### Changed
- Replaced `gitdamnit.png` with `gitdamnit.jpg` — compressed image from 3.5 MB to 250 KB to drastically reduce package size.

## [0.3.0] — 2026-05-08

### Added
- **Three-trigger automatic persistence:** Plugin no longer relies on agent initiative to save state.
  - Trigger A (`session.compacted`): Re-saves existing state or synthesizes a minimal checkpoint if none exists. Covers context-window-blowout scenarios.
  - Trigger B (`chat.message` every 5 messages): Re-saves existing state if dirty. Covers long-running sessions that crash before compaction. Does NOT synthesize — synthesis is Trigger A only.
  - Trigger C: Existing explicit `checkpoint_save` tool call (unchanged). Primary save path.
- **`handoff.md` generation:** Every write to `checkpoint.json` now also generates `.opencode/state/handoff.md` in human-readable markdown. Compatible with aider, Claude Code, Codex CLI, or any tool that can read a file.
- **Ring buffer snapshot history:** `.opencode/state/checkpoint-history.json` stores the last 10 snapshots (configurable via `MAX_HISTORY`). Every save appends to history; oldest entries are pruned automatically.
- **`checkpoint_list`** (replaced dead duplicate): Now lists snapshot history newest-first with name, savedAt, title, and status.
- **`checkpoint_load_snapshot`**: Read-only inspection of any named snapshot.
- **`checkpoint_restore_snapshot`**: Promotes a named snapshot to live state. Automatically saves current live state as `pre-restore-{timestamp}` before overwriting — one-step undo.
- **Schema versioning:** `SCHEMA_VERSION = 2` constant. Version mismatch logs a warning but does not block loading.
- **Named snapshots:** `checkpoint_save` accepts optional `snapshotName` argument to tag a snapshot for later reference.

### Changed
- `checkpoint_list` — was a dead duplicate of `checkpoint_load`. Now shows ring buffer history.
- `checkpoint_save` — new optional `snapshotName` parameter.
- Schema `version` field bumped from `1` to `2`.

### Fixed
- Silent data loss when agent context exhausted before manual `checkpoint_save` call.
- Silent data loss when agent works for extended periods without saving between compactions.

## 0.2.0 (2026-05-07)

### Fixed
- **Deep merge bug**: Changed shallow spread (`{...existing, ...data}`) to explicit `deepMerge()` that preserves `task` fields individually. Previously, calling `checkpoint_save({ status: "done" })` after `checkpoint_save({ title: "Fix auth" })` would lose the title.
- **Context deduplication**: Session compacting hook now tracks state hashes and skips re-injection when the checkpoint hasn't changed.
- **Missing source**: Added `plugins/checkpoint-orchestrator.ts` to the repository (was only in `dist/`).
- **Missing tests**: Added `tests/checkpoint_smoke.js` with 14 test cases covering fresh saves, deep merge, partial updates, status progression, and atomic write integrity.
- **ESM support**: Added `"type": "module"` to `package.json` for proper module resolution.
- **Cross-platform build**: Replaced Windows-only `copy` command with `fs.cpSync()`.
- **Build output**: `npm run build` now copies source to `dist/` correctly.

### Added
- `checkpoint_status` tool — lightweight status check without loading the full state.
- Restored fields to `checkpoint_save`: `objective`, `currentPlan`, `completedSteps`, `nextSteps`, `blockers`, `filesTouched`, `notes`.
- `"type": "module"` in `package.json`.
- Updated `@opencode-ai/plugin` dependency to `^1.14.40`.
- Added `plugins/` and `tests/` directories to published package files.

## 0.1.3 (2026-04-21)

### Added
- `checkpoint_clear` tool — deletes the checkpoint file.
- `checkpoint_list` tool — inspects current checkpoint state.
- Atomic writes — writes to a temp file then renames to final path to prevent corruption on crash.
- `exists()` helper function.

### Changed
- Simplified save schema to accept only `title`, `summary`, and `status`.

## 0.1.2 (2026-04-21)

### Added
- Initial release.
- `checkpoint_save` and `checkpoint_load` tools.
- `experimental.session.compacting` hook for automatic context injection.
- Basic shallow merge for state updates.
