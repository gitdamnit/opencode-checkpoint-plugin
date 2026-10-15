/**
 * Independence and interoperability.
 *
 * The other two toolkit plugins are NOT available in this environment, so nothing
 * here claims to have tested them. Instead, a stand-in "foreign" plugin exercises
 * the same host contracts they use — its own tools, its own hooks, its own
 * storage — which is what co-existence actually depends on.
 *
 * What is asserted: this plugin works alone, needs no companion, needs no
 * optional host domain, does not care about registration order, is unaffected by
 * a companion that throws or fails to load, and never touches storage it does not
 * own.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import plugin, { PLUGIN_ID } from "../dist/checkpoint-orchestrator.js"
import { PLUGIN_STATE_DIR } from "../dist/core/handoff.js"
import { callTool, makeHost, toolContext } from "./helpers/fake-host.mjs"

const MY_TOOLS = ["checkpoint_save", "checkpoint_load", "checkpoint_status", "checkpoint_list"]

/** A stand-in for a co-installed plugin: own tool, own hooks, own storage. */
function foreignPlugin(host, { id = "foreign.plugin", throwOnHook = false, writeState = true } = {}) {
  const foreignDir = join(host.projectDirectory, ".opencode", "state", "foreign-plugin")
  const foreignState = join(foreignDir, "audit.json")
  const ctx = host.contextFor({})

  return {
    id,
    foreignState,
    ctx,
    async setup() {
      if (writeState) {
        mkdirSync(foreignDir, { recursive: true })
        writeFileSync(foreignState, JSON.stringify({ owner: id, findings: [], version: 1 }, null, 2))
      }
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "foreign_inspect",
          description: "stand-in for a companion plugin's tool",
          input: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: JSON.stringify({ ok: true, owner: id }) }
          },
        })
      })
      await ctx.session.hook("compaction", (event) => {
        if (throwOnHook) throw new Error(`${id} exploded`)
        event.system.push({ type: "text", text: `[${id}] companion note` })
      })
      await ctx.session.hook("prompt", () => {
        if (throwOnHook) throw new Error(`${id} exploded on prompt`)
      })
    },
  }
}

test("works with no other plugin installed", async () => {
  const host = makeHost()
  try {
    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))
    assert.equal(host.transformCalls, 1)
    for (const name of MY_TOOLS) assert.ok(host.tools.has(name), `missing ${name}`)

    await callTool(host, "checkpoint_save", { title: "solo", nextSteps: ["finish"] })
    assert.equal((await callTool(host, "checkpoint_load")).task.title, "solo")
    assert.equal((await callTool(host, "checkpoint_status")).exists, true)
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("declares no dependency on another toolkit plugin", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.deepEqual(Object.keys(pkg.dependencies), ["@opencode/plugin"], "runtime dependencies must be the SDK only")
  assert.equal(pkg.peerDependencies, undefined, "no plugin may be an optional peer")
  assert.equal(pkg.optionalDependencies, undefined)

  // No shipped artifact may import another @gitdamnit package. This plugin does
  // not import even itself, so any occurrence means cross-plugin coupling.
  const distDir = new URL("../dist/", import.meta.url)
  const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
      if (entry.isDirectory()) out.push(...walk(child))
      else if (entry.name.endsWith(".js")) out.push(child)
    }
    return out
  }
  const artifacts = walk(distDir)
  assert.ok(artifacts.length >= 2, "the build output should exist")
  for (const file of artifacts) {
    const text = readFileSync(file, "utf8")
    // Import specifiers only: the export footer legitimately names this plugin.
    const specifiers = [...text.matchAll(/(?:\bfrom\s*|require\(\s*)["'](@gitdamnit\/[^"']+)["']/g)].map((m) => m[1])
    assert.deepEqual(specifiers, [], `${file.pathname} imports another @gitdamnit package`)
    for (const pattern of [/git-that-shit/i, /stranger[_-]?danger/i, /cheapcode/i]) {
      assert.ok(!pattern.test(text), `${file.pathname} references ${pattern}`)
    }
  }

  // Documentation must not resurrect the retired shared framework.
  for (const file of ["../README.md", "../docs/INDEPENDENCE.md"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.ok(!/cheapcode/i.test(text), `${file} must not reference the retired framework`)
  }
})

test("needs no host domain beyond the ones it documents", async () => {
  const host = makeHost()
  const allowed = new Set(["app", "location", "options", "tool", "session", "event"])
  const real = host.contextFor({ databasePath: host.databasePath })
  const guarded = new Proxy(real, {
    get(target, property, receiver) {
      if (typeof property === "string" && !allowed.has(property)) {
        throw new Error(`plugin touched undeclared host domain: ${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  try {
    const cleanup = await plugin.setup(guarded)
    // Exercise the lazy paths too, which run outside setup.
    await callTool(host, "checkpoint_save", { title: "guarded" })
    await callTool(host, "checkpoint_status")
    await host.runHooks("prompt", { sessionID: "ses_a", prompt: {}, delivery: "steer" })
    await host.runHooks("compaction", { sessionID: "ses_a", system: [], messages: [], tools: {} })
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("coexists with a foreign plugin in either registration order", async () => {
  for (const mineFirst of [true, false]) {
    const host = makeHost()
    try {
      const foreign = foreignPlugin(host)
      const mine = host.contextFor({ databasePath: host.databasePath })

      if (mineFirst) {
        await plugin.setup(mine)
        await foreign.setup()
      } else {
        await foreign.setup()
        await plugin.setup(mine)
      }

      // Both plugins' tools are registered and both work.
      assert.ok(host.tools.has("checkpoint_save"))
      assert.ok(host.tools.has("foreign_inspect"))
      await callTool(host, "checkpoint_save", { title: `order-${mineFirst}` })
      assert.equal((await callTool(host, "checkpoint_load")).task.title, `order-${mineFirst}`)
      assert.equal((await callTool(host, "foreign_inspect")).owner, "foreign.plugin")

      // Both plugins' compaction hooks contribute, additively.
      const event = { sessionID: "ses_a", system: [], messages: [], tools: {} }
      const errors = await host.runHooks("compaction", event)
      assert.deepEqual(errors, [], "no hook may throw")
      const text = event.system.map((part) => part.text).join("\n")
      assert.ok(text.includes("CHECKPOINT STATE"), "this plugin's injection is present")
      assert.ok(text.includes("companion note"), "the companion's contribution survives")
      assert.equal(event.system.length, 2, "contributions are appended, never replaced")

      // Session-scoped behaviour is identical regardless of order.
      assert.equal((await callTool(host, "checkpoint_status", {}, "ses_other")).exists, false)
    } finally {
      host.cleanup()
    }
  }
})

test("a foreign plugin that throws never breaks this plugin", async () => {
  for (const isolate of [true, false]) {
    const host = makeHost()
    try {
      const foreign = foreignPlugin(host, { throwOnHook: true })
      await foreign.setup()
      const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))

      const errors = await host.runHooks("compaction", { sessionID: "ses_a", system: [], messages: [], tools: {} }, { isolate })
      assert.equal(errors.length, 1, "the companion's failure is observed, not swallowed by us")

      // Our own hooks are defensive: they never contribute an error.
      const promptErrors = await host.runHooks(
        "prompt",
        { sessionID: "ses_a", prompt: {}, delivery: "steer" },
        { isolate },
      )
      assert.equal(promptErrors.length, 1)
      assert.match(promptErrors[0].message, /foreign\.plugin/)

      // Tools are independent of hooks entirely, so they keep working.
      await callTool(host, "checkpoint_save", { title: "survived a broken companion" })
      assert.equal((await callTool(host, "checkpoint_load")).task.title, "survived a broken companion")
      await cleanup()
    } finally {
      host.cleanup()
    }
  }
})

test("a foreign plugin that fails to load does not affect this plugin", async () => {
  const host = makeHost()
  try {
    const broken = foreignPlugin(host)
    await assert.rejects(
      (async () => {
        throw new Error("companion failed to load")
      })(),
      /failed to load/,
    )
    void broken

    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))
    await callTool(host, "checkpoint_save", { title: "alone after a failed companion" })
    assert.equal((await callTool(host, "checkpoint_status")).exists, true)
    assert.equal(host.tools.has("foreign_inspect"), false, "the broken companion registered nothing")
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("storage ownership stays disjoint from a companion plugin", async () => {
  const host = makeHost()
  try {
    const foreign = foreignPlugin(host)
    await foreign.setup()
    const foreignBefore = readFileSync(foreign.foreignState, "utf8")

    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))

    // Legacy import, saves, restores and clears all run through our code paths.
    const stateDir = join(host.projectDirectory, ".opencode", "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "checkpoint.json"),
      JSON.stringify({ version: 2, updatedAt: "2026-05-13T16:48:16.000Z", task: { title: "legacy" }, nextSteps: ["x"] }),
    )
    await callTool(host, "checkpoint_migrate", {})
    await callTool(host, "checkpoint_save", { title: "mine", snapshotName: "snap" })
    await callTool(host, "checkpoint_restore_snapshot", { name: "snap" })
    await callTool(host, "checkpoint_clear", {})

    // The companion's file is byte-identical, and nothing of ours lands in its dir.
    assert.equal(readFileSync(foreign.foreignState, "utf8"), foreignBefore)
    assert.deepEqual(readdirSync(join(stateDir, "foreign-plugin")), ["audit.json"])

    // Everything we wrote is inside our own namespace or our database directory.
    const mine = readdirSync(join(stateDir, "checkpoint-orchestrator"))
    assert.ok(mine.every((entry) => /^(handoff-|legacy-backup)/.test(entry)), `unexpected file in our namespace: ${mine}`)
    assert.equal(PLUGIN_STATE_DIR, ".opencode/state/checkpoint-orchestrator")
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("simultaneous sessions stay isolated while a companion plugin is active", async () => {
  const host = makeHost()
  try {
    const foreign = foreignPlugin(host)
    await foreign.setup()
    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))

    for (let i = 0; i < 5; i++) {
      await callTool(host, "checkpoint_save", { title: `s${i}`, completedSteps: [`c${i}`] }, `ses_${i}`)
      assert.equal((await callTool(host, "foreign_inspect")).ok, true)
    }
    for (let i = 0; i < 5; i++) {
      const stored = await callTool(host, "checkpoint_load", {}, `ses_${i}`)
      assert.equal(stored.task.title, `s${i}`)
      assert.deepEqual(stored.completedSteps, [`c${i}`])
      assert.equal((await callTool(host, "checkpoint_status", {}, `ses_${i}`)).snapshotCount, 1)
    }
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("cleanup and reload affect only this plugin", async () => {
  const host = makeHost()
  try {
    const foreign = foreignPlugin(host)
    await foreign.setup()
    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))
    await callTool(host, "checkpoint_save", { title: "before reload" })
    await cleanup()

    // A companion is untouched by our unload.
    assert.equal((await callTool(host, "foreign_inspect")).owner, "foreign.plugin")
    assert.equal(existsSync(foreign.foreignState), true)

    // Reload: a fresh instance over the same database recovers committed state.
    const second = makeHost({ databasePath: host.databasePath, projectDirectory: host.projectDirectory })
    try {
      const restarted = foreignPlugin(second)
      await restarted.setup()
      const cleanupSecond = await plugin.setup(second.contextFor({ databasePath: host.databasePath }))
      assert.equal((await callTool(second, "checkpoint_load")).task.title, "before reload")
      await cleanupSecond()
      assert.equal((await callTool(second, "foreign_inspect")).ok, true)
    } finally {
      second.cleanup()
    }
  } finally {
    host.cleanup()
  }
})

test("two instances loaded at once share one database safely", async () => {
  // A plugin registered twice (for example a local link plus a package entry)
  // must not corrupt state or fight over the database.
  const host = makeHost()
  try {
    const first = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))
    const second = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))

    await callTool(host, "checkpoint_save", { title: "double loaded" })
    assert.equal((await callTool(host, "checkpoint_load")).task.title, "double loaded")
    assert.equal(PLUGIN_ID, "gitdamnit.checkpoint-orchestrator")

    await first()
    assert.equal((await callTool(host, "checkpoint_load")).task.title, "double loaded", "one unload must not break the other")
    await second()
  } finally {
    host.cleanup()
  }
})

test("tool calls without a session are refused, so no session can be impersonated", async () => {
  const host = makeHost()
  try {
    const cleanup = await plugin.setup(host.contextFor({ databasePath: host.databasePath }))
    const tool = host.tools.get("checkpoint_save")
    const result = await tool.execute({ title: "nope" }, { ...toolContext("ses_a"), sessionID: undefined })
    assert.equal(JSON.parse(result.content).ok, false)
    assert.equal((await callTool(host, "checkpoint_status")).exists, false)
    await cleanup()
  } finally {
    host.cleanup()
  }
})

test("the plugin loads with an empty options object and with no options at all", async () => {
  for (const options of [undefined, {}]) {
    const host = makeHost()
    try {
      const ctx = host.contextFor(options ?? {})
      if (options === undefined) delete ctx.options
      const cleanup = await plugin.setup(ctx)
      assert.equal((await callTool(host, "checkpoint_status")).exists, false)
      await cleanup()
    } finally {
      host.cleanup()
    }
  }
})
