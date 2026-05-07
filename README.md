![gitdamnit](gitdamnit.png)

# @gitdamnit/checkpoint-orchestrator

Failure-resilient checkpointing for OpenCode — persistent task state, atomic writes, and resumable AI workflows.

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
| `checkpoint_save` | Save task state — deep-merges fields so partial updates never clobber. Accepts title, objective, status, summary, currentPlan, completedSteps, nextSteps, blockers, filesTouched, notes. |
| `checkpoint_load` | Load full current checkpoint state. |
| `checkpoint_status` | Quick status summary — exists, updatedAt, title, status, step counts, blockers count. |
| `checkpoint_clear` | Delete the checkpoint file entirely. |
| `checkpoint_list` | Inspect current state (single-state; multi-checkpoint history planned). |

## Automatic Context Injection

On session compacting, the plugin automatically injects the checkpoint state into the LLM's context with instructions to continue from where it left off. Deduplication prevents re-injecting unchanged state.

## Architecture & Storage

- **Storage Location:** `.opencode/state/checkpoint.json`
- **Atomic Writes:** Writes to a temp file first, then renames to final path — prevents corruption on crash or power loss.
- **Deep Merge:** Saving merges `task` fields individually rather than overwriting. You can save `title` in one call and `status` in another without losing data.
- **Deduplication:** The session compacting hook tracks state hashes to avoid injecting the same context multiple times.
