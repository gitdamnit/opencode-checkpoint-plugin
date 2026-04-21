import { mkdir, readFile, writeFile, access, rename, unlink } from "node:fs/promises"
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
}

const CHECKPOINT_DIR = ".opencode/state"
const FILE_NAME = "checkpoint.json"

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true })
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJSON(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

async function writeJSON(path: string, data: any) {
  await writeFile(path, JSON.stringify(data, null, 2))
}

export const CheckpointPlugin: Plugin = async (ctx) => {
  const dir = join(ctx.directory, CHECKPOINT_DIR)
  const file = join(dir, FILE_NAME)

  async function load() {
    return readJSON(file)
  }

  async function save(data: Partial<CheckpointData>) {
    await ensureDir(dir)

    const existing = await load()

    const merged = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...existing,
      ...data,
    }

    // Atomic write: write to a temp file, then rename to final to avoid partial writes
    const tmp = file + ".tmp"
    await writeFile(tmp, JSON.stringify(merged, null, 2))
    await rename(tmp, file)

    await ctx.client.app.log({
      body: {
        service: "checkpoint",
        level: "info",
        message: "Checkpoint saved",
      },
    })

    return merged
  }

  return {
    tool: {
      checkpoint_save: tool({
        description: "Save task state",
        args: {
          title: tool.schema.string().optional(),
          summary: tool.schema.string().optional(),
          status: tool.schema
            .enum(["not_started", "in_progress", "blocked", "done"])
            .optional(),
        },
        async execute(args) {
          return JSON.stringify(
            await save({
              task: {
                title: args.title,
                status: args.status,
              },
              summary: args.summary,
            }),
            null,
            2
          )
        },
      }),

      checkpoint_load: tool({
        description: "Load task state",
        args: {},
        async execute() {
          const data = await load()
          return JSON.stringify(data ?? { exists: false }, null, 2)
        },
      }),
      checkpoint_clear: tool({
        description: "Clear checkpoint state",
        args: {},
        async execute() {
          try {
            await unlink(file).catch(() => {})
          } catch {
            // ignore
          }
          return JSON.stringify({ cleared: true }, null, 2)
        },
      }),

      checkpoint_list: tool({
        description: "Load current checkpoint state",
        args: {},
        async execute() {
          const data = await load()
          return JSON.stringify(data ?? { exists: false }, null, 2)
        },
      }),
    },

    "experimental.session.compacting": async (_, output) => {
      const state = await load()
      if (!state) return

      output.context.push(`
## CHECKPOINT STATE

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`

Continue from this state. Do not redo completed work.
`)
    },
  }
}
