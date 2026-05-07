import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

type CheckpointData = {
  version: number
  updatedAt: string
  task?: {
    title?: string
    objective?: string
    status?: "not_started" | "in_progress" | "blocked" | "done"
  }
  summary?: string
  currentPlan?: string[]
  completedSteps?: string[]
  nextSteps?: string[]
  blockers?: string[]
  filesTouched?: string[]
  notes?: string[]
}

const CHECKPOINT_DIR = ".opencode/state"
const FILE_NAME = "checkpoint.json"

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

function deepMerge(
  existing: CheckpointData | null,
  incoming: Partial<CheckpointData>,
): CheckpointData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    task: {
      title: incoming.task?.title ?? existing?.task?.title,
      objective: incoming.task?.objective ?? existing?.task?.objective,
      status: incoming.task?.status ?? existing?.task?.status ?? "in_progress",
    },
    summary: incoming.summary ?? existing?.summary,
    currentPlan: incoming.currentPlan ?? existing?.currentPlan ?? [],
    completedSteps: incoming.completedSteps ?? existing?.completedSteps ?? [],
    nextSteps: incoming.nextSteps ?? existing?.nextSteps ?? [],
    blockers: incoming.blockers ?? existing?.blockers ?? [],
    filesTouched: incoming.filesTouched ?? existing?.filesTouched ?? [],
    notes: incoming.notes ?? existing?.notes ?? [],
  }
}

export const CheckpointPlugin: Plugin = async (ctx) => {
  const dir = join(ctx.directory, CHECKPOINT_DIR)
  const file = join(dir, FILE_NAME)

  let lastInjectedHash = ""

  async function load(): Promise<CheckpointData | null> {
    return readJSON<CheckpointData>(file)
  }

  async function save(data: Partial<CheckpointData>): Promise<CheckpointData> {
    await ensureDir(dir)

    const existing = await load()
    const merged = deepMerge(existing, data)

    // Atomic write: temp file + rename to prevent corruption on crash
    const tmp = file + ".tmp." + Date.now()
    await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8")
    await rename(tmp, file)

    await ctx.client.app.log({
      body: {
        service: "checkpoint",
        level: "info",
        message: "Checkpoint saved",
        extra: { file, updatedAt: merged.updatedAt },
      },
    })

    return merged
  }

  return {
    tool: {
      checkpoint_save: tool({
        description:
          "Save or update persistent task state for later recovery or handoff. Fields are deep-merged so partial updates don't clobber existing data.",
        args: {
          title: tool.schema.string().optional(),
          objective: tool.schema.string().optional(),
          status: tool.schema
            .enum(["not_started", "in_progress", "blocked", "done"])
            .optional(),
          summary: tool.schema.string().optional(),
          currentPlan: tool.schema.array(tool.schema.string()).optional(),
          completedSteps: tool.schema.array(tool.schema.string()).optional(),
          nextSteps: tool.schema.array(tool.schema.string()).optional(),
          blockers: tool.schema.array(tool.schema.string()).optional(),
          filesTouched: tool.schema.array(tool.schema.string()).optional(),
          notes: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args) {
          const result = await save({
            task: {
              title: args.title,
              objective: args.objective,
              status: args.status,
            },
            summary: args.summary,
            currentPlan: args.currentPlan,
            completedSteps: args.completedSteps,
            nextSteps: args.nextSteps,
            blockers: args.blockers,
            filesTouched: args.filesTouched,
            notes: args.notes,
          })
          return JSON.stringify(result, null, 2)
        },
      }),

      checkpoint_load: tool({
        description: "Load full current checkpoint state.",
        args: {},
        async execute() {
          const data = await load()
          return JSON.stringify(data ?? { exists: false }, null, 2)
        },
      }),

      checkpoint_status: tool({
        description: "Quick status check — whether a checkpoint exists and its current status.",
        args: {},
        async execute() {
          const data = await load()
          if (!data) {
            return JSON.stringify({ exists: false }, null, 2)
          }
          return JSON.stringify(
            {
              exists: true,
              updatedAt: data.updatedAt,
              title: data.task?.title ?? null,
              status: data.task?.status ?? null,
              completedSteps: data.completedSteps?.length ?? 0,
              nextSteps: data.nextSteps?.length ?? 0,
              blockers: data.blockers?.length ?? 0,
            },
            null,
            2,
          )
        },
      }),

      checkpoint_clear: tool({
        description: "Delete the checkpoint file entirely.",
        args: {},
        async execute() {
          await unlink(file).catch(() => {})
          return JSON.stringify({ cleared: true }, null, 2)
        },
      }),

      checkpoint_list: tool({
        description:
          "Inspect and returns current checkpoint state. (Currently single-state; multi-checkpoint history is planned.)",
        args: {},
        async execute() {
          const data = await load()
          return JSON.stringify(data ?? { exists: false }, null, 2)
        },
      }),
    },

    "experimental.session.compacting": async (_input, output) => {
      const state = await load()
      if (!state) return

      const hash = JSON.stringify(state)
      if (hash === lastInjectedHash) return // avoid re-injecting same state
      lastInjectedHash = hash

      output.context.push(`
## CHECKPOINT STATE

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`

Continue from this state.
Do not redo completed work.
Prioritize nextSteps.
`)
    },
  }
}
