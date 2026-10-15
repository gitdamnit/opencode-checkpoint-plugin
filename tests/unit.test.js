import { test } from "node:test"
import assert from "node:assert/strict"
import { basename, dirname } from "node:path"

import { PAYLOAD_SCHEMA_VERSION } from "../dist/core/types.js"
import {
  autoSnapshotName,
  clampArray,
  clampInt,
  clampString,
  contentFingerprint,
  deepMerge,
  normalizeData,
  safePathSegment,
  sanitizeArrayForMarkdown,
  sanitizeForMarkdown,
} from "../dist/core/util.js"
import { defaultDataRoot, resolveDatabasePath } from "../dist/core/paths.js"
import { handoffFilePath, renderHandoff } from "../dist/core/handoff.js"

test("deepMerge: partial update preserves every stored field", () => {
  const first = deepMerge(null, {
    task: { title: "Original", objective: "Ship it", status: "in_progress" },
    summary: "step one",
    currentPlan: ["a", "b"],
    completedSteps: ["done"],
    nextSteps: ["next"],
    blockers: ["blocked"],
    filesTouched: ["f.ts"],
    notes: ["note"],
  })
  const second = deepMerge(first, { task: { status: "blocked" } })

  assert.equal(second.task.title, "Original")
  assert.equal(second.task.objective, "Ship it")
  assert.equal(second.task.status, "blocked")
  assert.equal(second.summary, "step one")
  assert.deepEqual(second.currentPlan, ["a", "b"])
  assert.deepEqual(second.completedSteps, ["done"])
  assert.deepEqual(second.nextSteps, ["next"])
  assert.deepEqual(second.blockers, ["blocked"])
  assert.deepEqual(second.filesTouched, ["f.ts"])
  assert.deepEqual(second.notes, ["note"])
  assert.equal(second.version, PAYLOAD_SCHEMA_VERSION)
})

test("deepMerge: empty string and empty array are preserved, not treated as absent", () => {
  const first = deepMerge(null, { task: { title: "T" }, summary: "s", notes: ["n"] })
  const second = deepMerge(first, { summary: "", notes: [] })
  assert.equal(second.summary, "")
  assert.deepEqual(second.notes, [])
})

test("deepMerge: status defaults to in_progress only when never set", () => {
  assert.equal(deepMerge(null, {}).task.status, "in_progress")
  const done = deepMerge(null, { task: { status: "done" } })
  assert.equal(deepMerge(done, {}).task.status, "done")
})

test("deepMerge: ignores prototype pollution attempts", () => {
  const polluted = deepMerge(null, JSON.parse('{"task":{"__proto__":{"pwned":true}},"__proto__":{"alsoPwned":true}}'))
  assert.equal({}.pwned, undefined)
  assert.equal({}.alsoPwned, undefined)
  assert.equal(polluted.pwned, undefined)
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype)
})

test("contentFingerprint: ignores updatedAt but detects real change", () => {
  const a = deepMerge(null, { task: { title: "T" }, completedSteps: ["x"] })
  const b = { ...a, updatedAt: "2099-01-01T00:00:00.000Z" }
  assert.equal(contentFingerprint(a), contentFingerprint(b))

  const c = deepMerge(null, { task: { title: "T" }, completedSteps: ["x", "y"] })
  assert.notEqual(contentFingerprint(a), contentFingerprint(c))

  const d = deepMerge(null, { task: { title: "T2" }, completedSteps: ["x"] })
  assert.notEqual(contentFingerprint(a), contentFingerprint(d))
  assert.equal(contentFingerprint(null), "")
})

test("contentFingerprint: field order does not change the fingerprint", () => {
  const a = { version: 3, updatedAt: "t", task: { title: "T", status: "done" } }
  const b = { task: { status: "done", title: "T" }, updatedAt: "t", version: 3 }
  assert.equal(contentFingerprint(a), contentFingerprint(b))
})

test("clamping helpers enforce documented limits", () => {
  assert.equal(clampString("x".repeat(60_000), 10).length, 10)
  assert.equal(clampString(undefined, 10), undefined)
  assert.equal(clampString(42, 10), undefined)

  assert.equal(clampArray(Array.from({ length: 1500 }, (_, i) => String(i)), 10).length, 10)
  assert.equal(clampArray("not-an-array", 10), undefined)
  assert.deepEqual(clampArray([1, null, "a"], 10), ["1", "a"])

  assert.equal(clampInt(5, 1, 10, 3), 5)
  assert.equal(clampInt(0, 1, 10, 3), 1)
  assert.equal(clampInt(99, 1, 10, 3), 10)
  assert.equal(clampInt("nope", 1, 10, 3), 3)
  assert.equal(clampInt(undefined, 1, 10, 3), 3)
  assert.equal(clampInt(4.7, 1, 10, 3), 4)
})

test("markdown sanitization escapes angle brackets and quotes", () => {
  assert.equal(sanitizeForMarkdown("<script>alert(\"x\")</script>"), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
  assert.equal(sanitizeForMarkdown(undefined), "")
  assert.deepEqual(sanitizeArrayForMarkdown(["<b>", "ok"]), ["&lt;b&gt;", "ok"])
  assert.deepEqual(sanitizeArrayForMarkdown(undefined), [])
})

test("normalizeData coerces anything into a well-formed payload", () => {
  const empty = normalizeData(null)
  assert.equal(empty.version, PAYLOAD_SCHEMA_VERSION)
  assert.deepEqual(empty.currentPlan, [])
  assert.deepEqual(empty.notes, [])
  assert.equal(typeof empty.updatedAt, "string")

  const flat = normalizeData({ title: "flat", status: "done", summary: "s", currentPlan: ["p"] })
  assert.equal(flat.task.title, "flat")
  assert.equal(flat.task.status, "done")

  const bad = normalizeData({ task: { status: "not-a-status" }, currentPlan: "nope", updatedAt: 12 })
  assert.equal(bad.task.status, undefined)
  assert.deepEqual(bad.currentPlan, [])
  assert.equal(bad.updatedAt.length > 0, true)
})

test("autoSnapshotName is timestamped, ordered, and collision-free across rapid calls", () => {
  const a = autoSnapshotName(new Date(1000))
  const b = autoSnapshotName(new Date(2000))
  assert.match(a, /^auto-1000-/)
  assert.match(b, /^auto-2000-/)
  assert.notEqual(a, b)

  // The whole point: many calls in the same millisecond must not collide, or the
  // (session, name) constraint would silently drop history.
  const sameMs = new Set(Array.from({ length: 500 }, () => autoSnapshotName(new Date(5000))))
  assert.equal(sameMs.size, 500)
})

test("defaultDataRoot uses the platform convention", () => {
  assert.equal(
    defaultDataRoot({ platform: "linux", env: {}, home: "/home/me" }),
    "/home/me/.local/share/opencode/checkpoint-orchestrator",
  )
  assert.equal(
    defaultDataRoot({ platform: "linux", env: { XDG_DATA_HOME: "/xdg" }, home: "/home/me" }),
    "/xdg/opencode/checkpoint-orchestrator",
  )
  assert.equal(
    defaultDataRoot({ platform: "darwin", env: {}, home: "/Users/me" }),
    "/Users/me/Library/Application Support/opencode/checkpoint-orchestrator",
  )
  assert.equal(
    defaultDataRoot({ platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me" }),
    "C:\\Users\\me\\AppData\\Roaming/opencode/checkpoint-orchestrator",
  )
})

test("resolveDatabasePath honours explicit override, then env, then default", () => {
  const ctx = { platform: "linux", env: {}, home: "/home/me" }
  assert.equal(resolveDatabasePath("/tmp/custom.db", ctx), "/tmp/custom.db")
  assert.equal(
    resolveDatabasePath(undefined, { ...ctx, env: { CHECKPOINT_ORCHESTRATOR_DB: "/tmp/env.db" } }),
    "/tmp/env.db",
  )
  assert.equal(resolveDatabasePath("  ", ctx), "/home/me/.local/share/opencode/checkpoint-orchestrator/checkpoints.db")
  assert.equal(resolveDatabasePath(":memory:", ctx), ":memory:")
  // override wins over env
  assert.equal(
    resolveDatabasePath("/tmp/custom.db", { ...ctx, env: { CHECKPOINT_ORCHESTRATOR_DB: "/tmp/env.db" } }),
    "/tmp/custom.db",
  )
})

test("handoff rendering contains every documented section", () => {
  const markdown = renderHandoff(
    deepMerge(null, {
      task: { title: "Task <b>", objective: "Obj", status: "blocked" },
      summary: "Sum",
      currentPlan: ["one"],
      completedSteps: ["two"],
      nextSteps: ["three"],
      blockers: ["four"],
      filesTouched: ["five.ts"],
      notes: ["six"],
    }),
    "ses_123",
  )

  for (const heading of [
    "# Handoff —",
    "## Summary",
    "## Current Plan",
    "## Completed Steps",
    "## Next Steps",
    "## Blockers",
    "## Files Touched",
    "## Notes",
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`)
  }
  assert.ok(markdown.includes("**Status:** blocked"))
  assert.ok(markdown.includes("**Session:** ses_123"))
  assert.ok(markdown.includes("&lt;b&gt;"))
  assert.ok(!markdown.includes("<b>"))
  assert.ok(markdown.includes("1. one"))
  assert.ok(markdown.includes("- [x] two"))
  assert.ok(markdown.includes("- [ ] three"))
  assert.ok(markdown.includes("⚠️ four"))
  assert.ok(markdown.includes("📄 five.ts"))
  assert.ok(markdown.includes("Do not edit manually"))
})

test("handoff export paths are per-session and cannot escape the state directory", () => {
  const a = handoffFilePath("/proj", "ses_aaa")
  const b = handoffFilePath("/proj", "ses_bbb")
  assert.notEqual(a, b)
  assert.equal(a, "/proj/.opencode/state/handoff-ses_aaa.md")

  // Containment is the real invariant: whatever the session id contains, the
  // export always stays directly inside the session's state directory.
  for (const hostile of ["../../etc/passwd", "..", "/", "a/../../b", "\u0000null"]) {
    const resolved = handoffFilePath("/proj", hostile)
    assert.equal(dirname(resolved), "/proj/.opencode/state", `escaped via ${hostile}`)
    assert.ok(basename(resolved).startsWith("handoff-"), `bad filename for ${hostile}`)
    assert.notEqual(basename(resolved), "..")
  }

  assert.equal(safePathSegment("../../etc/passwd"), "__.._etc_passwd")
  assert.equal(safePathSegment(".."), "_")
  assert.equal(safePathSegment(""), "_")
})
