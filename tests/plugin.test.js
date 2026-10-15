/**
 * Exercises the real V2 plugin entry point (dist/checkpoint-orchestrator.js) and
 * the real tool/hook wiring through a fake V2 context. This is the layer the
 * legacy suites never touched: the previous 979 tests re-implemented the logic
 * instead of calling it.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { PLUGIN_ID, PLUGIN_VERSION, extractSessionID, resolveOptions } from "../dist/checkpoint-orchestrator.js"
import { callTool, makeHost } from "./helpers/fake-host.mjs"

// Suite guard: never let a test touch the developer's real data directory. Some
// cases deliberately construct a context with no options, so the environment
// override is the only thing keeping the default path out of the picture.
process.env.CHECKPOINT_ORCHESTRATOR_DB = join(mkdtempSync(join(tmpdir(), "co-guard-")), "guard.db")

const EXPECTED_TOOLS = [
  "checkpoint_save",
  "checkpoint_load",
  "checkpoint_status",
  "checkpoint_clear",
  "checkpoint_list",
  "checkpoint_load_snapshot",
  "checkpoint_restore_snapshot",
]

// The fake host is shared with the interoperability suite.
function harness(options = {}) {
  const host = makeHost()
  host.ctx = host.contextFor({ databasePath: host.databasePath, ...options })
  return host
}

const call = callTool

test("the plugin exports a V2 definition with a stable id", () => {
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(typeof plugin.setup, "function")
  assert.equal(PLUGIN_ID, "gitdamnit.checkpoint-orchestrator")
})

test("the declared plugin version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.version, PLUGIN_VERSION)
})

test("the deprecated V1 SDK is gone and the V2 SDK is a dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.dependencies["@opencode-ai/plugin"], undefined)
  assert.match(pkg.dependencies["@opencode/plugin"], /^[\^~]?2\./)
})

test("setup registers every tool, including the seven preserved names", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    assert.equal(h.transformCalls, 1)
    for (const name of EXPECTED_TOOLS) assert.ok(h.tools.has(name), `missing tool ${name}`)
    assert.ok(h.tools.has("checkpoint_migrate"))
    assert.equal(h.tools.size, EXPECTED_TOOLS.length + 1)
    assert.equal(typeof cleanup, "function")
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("tool schemas are JSON Schema objects the model can be given", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    for (const [name, tool] of h.tools) {
      assert.equal(typeof tool.description, "string", `${name} needs a description`)
      assert.ok(tool.description.length > 20, `${name} description is too thin`)
      assert.equal(tool.input.type, "object", `${name} must take an object`)
      assert.equal(tool.input.additionalProperties, false, `${name} must reject unknown fields`)
      assert.equal(typeof tool.input.properties, "object", `${name} needs properties`)
    }
    assert.deepEqual(h.tools.get("checkpoint_load_snapshot").input.required, ["name"])
    assert.deepEqual(h.tools.get("checkpoint_save").input.properties.status.enum, [
      "not_started",
      "in_progress",
      "blocked",
      "done",
    ])
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("the full tool lifecycle works through the real wiring", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)

    const saved = await call(h, "checkpoint_save", {
      title: "Migration",
      objective: "Move to SQLite",
      status: "in_progress",
      summary: "started",
      currentPlan: ["step 1", "step 2"],
      completedSteps: ["step 1"],
      nextSteps: ["step 2"],
      blockers: [],
      filesTouched: ["plugins/x.ts"],
      notes: ["note"],
      snapshotName: "kickoff",
    })
    assert.equal(saved.task.title, "Migration")
    assert.deepEqual(saved.currentPlan, ["step 1", "step 2"])

    const loaded = await call(h, "checkpoint_load")
    assert.equal(loaded.task.objective, "Move to SQLite")

    const status = await call(h, "checkpoint_status")
    assert.equal(status.exists, true)
    assert.equal(status.completedSteps, 1)
    assert.equal(status.nextSteps, 1)
    assert.equal(status.snapshotCount, 1)
    assert.equal(status.sessionID, "ses_a")

    const listed = await call(h, "checkpoint_list")
    assert.equal(listed.count, 1)
    assert.equal(listed.snapshots[0].name, "kickoff")
    assert.equal(listed.snapshots[0].kind, "named")

    const snapshot = await call(h, "checkpoint_load_snapshot", { name: "kickoff" })
    assert.equal(snapshot.task.title, "Migration")

    await call(h, "checkpoint_save", { status: "blocked", blockers: ["waiting"] })
    const restored = await call(h, "checkpoint_restore_snapshot", { name: "kickoff" })
    assert.equal(restored.restored, true)
    assert.ok(restored.undoSnapshot.startsWith("pre-restore-"))

    const afterRestore = await call(h, "checkpoint_load")
    assert.deepEqual(afterRestore.blockers, [])
    assert.equal(afterRestore.task.status, "in_progress")

    const missing = await call(h, "checkpoint_load_snapshot", { name: "nope" })
    assert.equal(missing.error, "Snapshot not found")
    assert.ok(Array.isArray(missing.available))

    const cleared = await call(h, "checkpoint_clear")
    assert.equal(cleared.cleared, true)
    assert.equal((await call(h, "checkpoint_status")).exists, false)

    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("two sessions using the same tools never see each other's data", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)

    await call(h, "checkpoint_save", { title: "session-A", nextSteps: ["a"] }, "ses_A")
    await call(h, "checkpoint_save", { title: "session-B", nextSteps: ["b1", "b2"] }, "ses_B")
    await call(h, "checkpoint_save", { title: "session-A2" }, "ses_A")

    const a = await call(h, "checkpoint_load", {}, "ses_A")
    const b = await call(h, "checkpoint_load", {}, "ses_B")
    assert.equal(a.task.title, "session-A2")
    assert.deepEqual(a.nextSteps, ["a"])
    assert.equal(b.task.title, "session-B")
    assert.deepEqual(b.nextSteps, ["b1", "b2"])

    const listA = await call(h, "checkpoint_list", {}, "ses_A")
    const listB = await call(h, "checkpoint_list", {}, "ses_B")
    assert.equal(listA.count, 2)
    assert.equal(listB.count, 1)
    for (const entry of listA.snapshots) assert.notEqual(entry.title, "session-B")

    // Clearing A must not touch B.
    await call(h, "checkpoint_clear", {}, "ses_A")
    assert.equal((await call(h, "checkpoint_status", {}, "ses_A")).exists, false)
    assert.equal((await call(h, "checkpoint_status", {}, "ses_B")).exists, true)

    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("a tool call without a session id refuses to touch state", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    const result = await h.tools.get("checkpoint_save").execute({ title: "x" }, { sessionID: undefined })
    const payload = JSON.parse(result.content)
    assert.equal(payload.ok, false)
    assert.match(payload.error, /session id/i)
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("the compaction hook injects state once and then deduplicates", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    assert.equal(h.hooksFor("compaction").length, 1)
    assert.equal(h.hooksFor("prompt").length, 1)

    await call(h, "checkpoint_save", { title: "Inflight", nextSteps: ["finish"] }, "ses_c")
    const compaction = h.hookFor("compaction")

    const eventOne = { sessionID: "ses_c", system: [], messages: [], tools: {} }
    await compaction(eventOne)
    assert.equal(eventOne.system.length, 1)
    assert.ok(eventOne.system[0].text.includes("Inflight"))

    const eventTwo = { sessionID: "ses_c", system: [], messages: [], tools: {} }
    await compaction(eventTwo)
    assert.equal(eventTwo.system.length, 0, "identical state must not be injected twice")

    const eventOther = { sessionID: "ses_other", system: [], messages: [], tools: {} }
    await compaction(eventOther)
    assert.equal(eventOther.system.length, 0, "a session with no checkpoint gets no injection")

    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("compaction synthesizes a marked placeholder when nothing was ever saved", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    const compaction = h.hookFor("compaction")

    const event = { sessionID: "ses_fresh", system: [], messages: [], tools: {} }
    await compaction(event)
    assert.equal(event.system.length, 0, "a synthesized placeholder is not injected")

    const status = await call(h, "checkpoint_status", {}, "ses_fresh")
    assert.equal(status.exists, true)
    assert.equal(status.synthesized, true)
    assert.equal(status.title, "Auto-synthesized checkpoint")
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("the prompt hook counts per session and only saves on real change", async () => {
  const h = harness({ autosaveEvery: 3 })
  try {
    const cleanup = await plugin.setup(h.ctx)
    const prompt = h.hookFor("prompt")

    for (let i = 0; i < 3; i++) await prompt({ sessionID: "ses_p", prompt: {}, delivery: "steer" })
    // No checkpoint exists yet, so nothing is invented.
    assert.equal((await call(h, "checkpoint_status", {}, "ses_p")).exists, false)

    await call(h, "checkpoint_save", { title: "real work" }, "ses_p")
    const before = (await call(h, "checkpoint_list", {}, "ses_p")).count
    for (let i = 0; i < 3; i++) await prompt({ sessionID: "ses_p", prompt: {}, delivery: "steer" })
    const after = (await call(h, "checkpoint_list", {}, "ses_p")).count
    assert.equal(after, before, "an unchanged periodic save must not add snapshot noise")

    await call(h, "checkpoint_save", { completedSteps: ["done"] }, "ses_p")
    for (let i = 0; i < 3; i++) await prompt({ sessionID: "ses_p", prompt: {}, delivery: "steer" })
    // The periodic trigger itself never invents progress: state is unchanged, so
    // nothing new is recorded even though the counter fired.
    assert.equal((await call(h, "checkpoint_list", {}, "ses_p")).count, before + 1)

    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("the session.compacted event is a durable safety net", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    await call(h, "checkpoint_save", { title: "event-driven", completedSteps: ["x"] }, "ses_ev")

    h.stream.push({ type: "session.compacted", data: { sessionID: "ses_ev" } })
    // Give the async subscription a turn to process.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const status = await call(h, "checkpoint_status", {}, "ses_ev")
    assert.equal(status.exists, true)
    assert.equal(status.title, "event-driven")
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("extractSessionID accepts the shapes the event stream uses", () => {
  assert.equal(extractSessionID({ sessionID: "ses_direct" }), "ses_direct")
  assert.equal(extractSessionID({ type: "session.compacted", data: { sessionID: "ses_nested" } }), "ses_nested")
  assert.equal(extractSessionID({ type: "session.compacted", data: {} }), null)
  assert.equal(extractSessionID(null), null)
  assert.equal(extractSessionID("nope"), null)
  assert.equal(extractSessionID({ data: { sessionID: "" } }), null)
})

test("cleanup closes the database, after which tools report an error instead of crashing", async () => {
  const h = harness()
  try {
    const cleanup = await plugin.setup(h.ctx)
    await call(h, "checkpoint_save", { title: "before cleanup" })
    await cleanup()

    const payload = await call(h, "checkpoint_status")
    assert.equal(payload.ok, false)
    assert.match(payload.error, /storage|closed|database/i)
  } finally {
    h.cleanup()
  }
})

test("an unusable database path makes the plugin inert rather than fatal", async () => {
  // A regular file where a directory is required: creating the parent directory
  // fails immediately with ENOTDIR, deterministically and without permission games.
  const blockedRoot = mkdtempSync(join(tmpdir(), "co-blocked-"))
  const blockerFile = join(blockedRoot, "not-a-directory")
  writeFileSync(blockerFile, "in the way")

  const h = harness({ databasePath: join(blockerFile, "checkpoints.db") })
  try {
    const cleanup = await plugin.setup(h.ctx)
    assert.equal(typeof cleanup, "function")
    const payload = await call(h, "checkpoint_status")
    assert.equal(payload.ok, false)
    assert.match(payload.error, /Checkpoint storage unavailable/)
    await cleanup()
  } finally {
    h.cleanup()
    rmSync(blockedRoot, { recursive: true, force: true })
  }
})

test("options are validated and clamped before use", () => {
  const resolved = resolveOptions({
    historyLimit: 99_999,
    autosaveEvery: -5,
    handoffDir: "../../escape",
    maxInjectionChars: 10,
    databasePath: "/tmp/x.db",
  })
  assert.equal(resolved.service.historyLimit, 1000)
  assert.equal(resolved.service.autosaveEvery, 0, "negative values clamp to disabled")
  assert.equal(
    resolved.service.handoffDirectory,
    ".opencode/state/checkpoint-orchestrator",
    "path traversal is rejected",
  )
  assert.equal(resolved.service.maxInjectionChars, 1000)
  assert.equal(resolved.databasePath, "/tmp/x.db")

  const defaults = resolveOptions(undefined)
  assert.equal(defaults.service.handoffEnabled, true)
  assert.equal(defaults.service.autosaveEvery, 5)
  assert.equal(defaults.legacyImport, true)

  const disabled = resolveOptions({ handoff: false, autosaveEvery: false, legacyImport: "off", handoffDir: "custom/dir" })
  assert.equal(disabled.service.handoffEnabled, false)
  assert.equal(disabled.service.autosaveEvery, 0)
  assert.equal(disabled.legacyImport, false)
  assert.equal(disabled.service.handoffDirectory, "custom/dir")
})

test("legacy state is looked for in the session's own project, not the plugin's", async () => {
  const h = harness()
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const otherProject = join(h.dir, "other-project")
    const otherState = join(otherProject, ".opencode", "state")
    mkdirSync(otherState, { recursive: true })
    writeFileSync(
      join(otherState, "checkpoint.json"),
      JSON.stringify({ version: 2, task: { title: "other project work" } }),
    )
    // This session belongs to a different project than the plugin's location.
    h.projects.set("ses_foreign", "proj-2")
    h.sessionDirectories["ses_foreign"] = otherProject

    const cleanup = await plugin.setup(h.ctx)
    const report = await call(h, "checkpoint_migrate", {}, "ses_foreign")
    assert.equal(report.legacyPresent, true, "legacy files in the session's own project must be found")

    const adopted = await call(h, "checkpoint_migrate", { adopt: true }, "ses_foreign")
    assert.equal(adopted.adopted, true)
    const live = await call(h, "checkpoint_load", {}, "ses_foreign")
    assert.equal(live.task.title, "other project work")

    // The handoff export follows the same rule.
    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(otherState, "checkpoint-orchestrator", "handoff-ses_foreign.md")), true)
    await cleanup()
  } finally {
    h.cleanup()
  }
})

test("a legacy JSON checkpoint is reported and can be adopted explicitly", async () => {
  const h = harness()
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const stateDir = join(h.projectDirectory, ".opencode", "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "checkpoint.json"),
      JSON.stringify({ version: 2, updatedAt: "2026-01-01T00:00:00.000Z", task: { title: "old work" }, nextSteps: ["x"] }),
    )

    const cleanup = await plugin.setup(h.ctx)

    // The plugin imports it into the legacy namespace during setup, never into
    // the caller's session.
    const report = await call(h, "checkpoint_migrate", {}, "ses_new")
    assert.equal(report.legacyPresent, true)
    assert.equal(report.adopted, false)
    assert.equal((await call(h, "checkpoint_status", {}, "ses_new")).exists, false)

    const adopted = await call(h, "checkpoint_migrate", { adopt: true }, "ses_new")
    assert.equal(adopted.adopted, true)
    const live = await call(h, "checkpoint_load", {}, "ses_new")
    assert.equal(live.task.title, "old work")
    assert.deepEqual(live.nextSteps, ["x"])

    await cleanup()
  } finally {
    h.cleanup()
  }
})
