# Changelog

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

### Fixed
- TOCTOU race in `checkpoint_restore_snapshot` — snapshot restore now uses a single history read.
- Removed dead `isDirty` variable.

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
