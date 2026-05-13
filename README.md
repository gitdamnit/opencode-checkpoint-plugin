![gitdamnit](gitdamnit.jpg)

# @gitdamnit/checkpoint-orchestrator

![npm version](https://img.shields.io/npm/v/@gitdamnit/checkpoint-orchestrator)
![npm](https://img.shields.io/npm/dm/@gitdamnit/checkpoint-orchestrator)
![CI](https://github.com/gitdamnit/opencode-checkpoint-plugin/actions/workflows/ci.yml/badge.svg)
![Tests](https://img.shields.io/badge/tests-979%20passed-brightgreen)

Failure-resilient checkpointing for OpenCode — persistent task state, atomic writes, automatic persistence, and resumable AI workflows.

Prevents context loss when switching models or providers during a session. The next model picks up exactly where the last one left off.

## Install

```bash
npm install @gitdamnit/checkpoint-orchestrator
```

Then register in your OpenCode config:

```json
{
  "plugin": ["@gitdamnit/checkpoint-orchestrator"]
}
```

Or via CLI:

```bash
opencode plugin @gitdamnit/checkpoint-orchestrator
```

## Tools Provided

| Tool | Description |
|------|-------------|
| `checkpoint_save` | Save task state — deep-merges fields so partial updates never clobber. Accepts title, objective, status, summary, currentPlan, completedSteps, nextSteps, blockers, filesTouched, notes, and optional `snapshotName` to tag this save. |
| `checkpoint_load` | Load full current checkpoint state. |
| `checkpoint_status` | Quick status summary — exists, updatedAt, title, status, step counts, blockers count. |
| `checkpoint_clear` | Delete the checkpoint file entirely. |
| `checkpoint_list` | List all snapshot history entries newest-first with name, savedAt, title, and status. |
| `checkpoint_load_snapshot` | Read-only inspection of a named snapshot's full data. |
| `checkpoint_restore_snapshot` | Promote a named snapshot to live state. Automatically creates a `pre-restore-{timestamp}` undo point. |

## Automatic Persistence

The plugin uses three independent triggers to ensure state is never lost — no agent initiative required:

| Trigger | Fires when | Behavior |
|---|---|---|
| **A — `session.compacted`** | Context window fills, OpenCode compacts | Re-saves existing state, or synthesizes a minimal checkpoint if none exists |
| **B — `chat.message`** | Every 5th user message | Re-saves existing state only (no synthesis). Counter resets on manual save. |
| **C — `checkpoint_save`** | Agent explicitly calls the tool | Primary save path. Full state from agent, optional `snapshotName`. |

Triggers A and B are safety nets. Trigger C is the primary save path.

## Automatic Context Injection

On session compacting, the plugin automatically injects the checkpoint state into the LLM's context with instructions to continue from where it left off. Deduplication prevents re-injecting unchanged state.

## Test Suite

All 979 tests pass on Node.js 18, 20, and 22 in CI.

### `tests/checkpoint_smoke.js` — 85 tests, 0 failed

Core save/load lifecycle, deep merge, partial updates, status progression, atomic write integrity, handoff generation, ring buffer pruning, snapshot naming, and auto-save counter threshold/reset.

### `tests/checkpoint_hardening.js` — 77 tests, 0 failed

| Category | Tests | Coverage |
|----------|-------|----------|
| Security | 4 | Prototype pollution via `__proto__`, `constructor.prototype`, nested `__proto__`, and array payloads |
| Markdown injection | 5 | Script tags, code fences, image/link syntax all escaped |
| Fuzz | 8 | String/number/boolean/array/null/undefined incoming types |
| Stress | 9 | 100 rapid merges, ring buffer at limits, all-fields-max payload |
| Edge cases | 11 | Double merges, all 4 status transitions, empty state, special chars, multiline, TOCTOU, missing version, missing directory |
| Atomic integrity | 4 | Temp file uniqueness, valid output, partial crash recovery |
| Handoff | 30 | All field fallbacks, nullish input, version checks, emoji prefixes, long content |

### `tests/checkpoint_comprehensive.js` — 817 tests, 0 failed

| Section | Tests | Coverage |
|---------|-------|----------|
| Part 1 — Property Fuzz | ~600 (100 iters × 6 asserts) | Random titles, statuses, summaries, plans — verifies deep merge stability under random input combinations |
| Part 2 — Filesystem Lifecycle | 13 | Full create → save → load → handoff → clear cycle across 5 sequential saves |
| Part 3 — Recovery & Resilience | 11 | Corrupted JSON, corrupted history, missing directory with auto-mkdir, empty state file, missing handoff regeneration, mid-write crash survival |
| Part 4 — Atomic Write Verification | 5 | 50 rapid temp-file writes with unique naming, zero leftover temp files, large payload (10KB fields, 500-item arrays) data completeness |
| Part 5 — Ring Buffer History | 19 | Exact boundary (10 entries), overflow pruning, empty/single edge cases, named vs auto snapshots, newest-first ordering |
| Part 6 — Deep Merge Combinatorial | 32 | All 16 status transitions, all 10 field types, partial field preservation, empty strings, null values, 3-step chained merges |
| Part 7 — Sanitization | 21 | 6 XSS vectors (script, img, anchor, angle brackets, quotes), undefined/null/number/non-angle inputs, array sanitization, unicode (7 languages/charsets), full handoff injection context |
| Part 8 — Clamp Boundaries | 20 | String input: undefined/null/number/empty/exact/+1/way-over/max/max+1. Array: undefined/null/not-array/empty/exact/+1/way-over/max/max+1 |
| Part 9 — Schema Versioning | 13 | Current version detection, v1 migration, v0 handling, missing version field, forward compatibility |
| Part 10 — Timestamp & Format | 6 | ISO 8601 format, Z/offset suffix, valid Date parsing, recency (within 5s), not in future |
| Part 11 — Stress | 10 | 1000 rapid deep merges with title/step/note accumulation, 200 file saves with ring buffer verification, zero temp file leaks |
| Part 12 — Security | 8 | 4 prototype pollution variants (`__proto__`, `constructor.prototype`, nested, array), 100K-element DoS, deeply nested payloads, injection in all handoff contexts |
| Part 13 — Snapshot Operations | 5 | Find by name, unknown name, pre-restore undo point creation |
| Part 14 — Handoff Structure | 30 | All 10 markdown sections present, correct numbering/counts, 10 empty-field fallback strings |
| Part 15 — Checkpoint Clear | 5 | All 3 files deleted, graceful handling when no files exist |

## Architecture & Storage

- **Storage Location:** `.opencode/state/`
  - `checkpoint.json` — current live state (atomic write: temp + rename)
  - `checkpoint-history.json` — ring buffer of last 10 snapshots (atomic write)
  - `handoff.md` — human-readable markdown mirror of live state (plain write, derived)
- **Atomic Writes:** Primary state files write to a temp file first, then rename to final path — prevents corruption on crash or power loss.
- **Deep Merge:** Saving merges `task` fields individually rather than overwriting. You can save `title` in one call and `status` in another without losing data.
- **Deduplication:** The session compacting hook tracks state hashes to avoid injecting the same context multiple times.
- **Ring Buffer History:** Every save appends a copy to `checkpoint-history.json`. History is pruned to `MAX_HISTORY` (default: 10) automatically — oldest entries fall off.
- **Schema Versioning:** Checkpoint data files include a version field for forward compatibility. Old files load with a warning rather than breaking.
- **Handoff File:** `handoff.md` is generated on every write in markdown format readable by any tool — aider, Claude Code, Codex CLI, or a text editor.
