![gitdamnit]()
# @gitdamnit/checkpoint-orchestrator

A minimal OpenCode plugin that provides persistent task checkpointing.

This plugin allows AI workflows to save, load, and clear state deterministically, enabling resumable processes rather than fragile sessions.

## Install

```bash
npm install @gitdamnit/checkpoint-orchestrator
```

## Usage

```typescript
import { CheckpointPlugin } from "@gitdamnit/checkpoint-orchestrator";

// Register with your OpenCode setup
```

## Tools Provided

The plugin provides the following tools for the LLM:

- `checkpoint_save`: Saves task state (accepts title, summary, and status).
- `checkpoint_load`: Loads current task state.
- `checkpoint_clear`: Clears checkpoint state.
- `checkpoint_list`: Inspects and returns current checkpoint state (currently does not list multiple checkpoints, just the current one).

## Architecture & Storage

- **Storage Location:** State is saved to `.opencode/state/checkpoint.json`.
- **Atomic Writes:** All writes use a temp-file plus rename mechanism to ensure atomic updates and prevent corrupted states during crashes.
- **Merge Behavior:** Saving performs a shallow merge of the top-level state and a deep merge of the nested `task` field to avoid overwriting existing task objectives or context.
