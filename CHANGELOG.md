# Changelog

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
