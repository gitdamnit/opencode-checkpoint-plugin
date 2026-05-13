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

| Suite | Tests | Result | Coverage |
|-------|-------|--------|----------|
| `checkpoint_smoke.js` | 85 | `85 passed, 0 failed` | Core functionality: fresh saves, deep merge, partial updates, status progression, atomic writes, handoff generation, ring buffer, snapshot ops, auto-save counter |
| `checkpoint_hardening.js` | 77 | `77 passed, 0 failed` | Security: prototype pollution, Markdown injection, XSS vectors. Fuzz: type coercion, null/undefined handling. Stress: 100 merges, ring buffer limits. Edge cases: status transitions, empty states, TOCTOU, schema versions |
| `checkpoint_comprehensive.js` | 817 | `817 passed, 0 failed` | Property-based fuzz (100 iterations), filesystem lifecycle, recovery & resilience, atomic verification, ring buffer boundaries, deep merge combinatorial (all field types, empty strings, null, chaining), sanitization (special chars, unicode, handoff context), clamp boundaries, schema versioning, timestamp ISO format, stress (1000 merges + 200 file saves), security (4 prototype pollution variants, DoS, injection across all contexts), snapshot find/undo, handoff output structure, checkpoint clear |
| **Total** | **979** | **All passing** | |

All tests run in CI on Node.js 18, 20, and 22.

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
