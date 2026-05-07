import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { deepMerge } = (() => {
  function deepMerge(existing, incoming) {
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
  return { deepMerge }
})()

let passed = 0
let failed = 0

function assert(desc, ok) {
  if (ok) { passed++; console.log(`  PASS: ${desc}`) }
  else { failed++; console.error(`  FAIL: ${desc}`) }
}

// Test 1: Fresh save
const first = deepMerge(null, {
  task: { title: "Fix auth", status: "in_progress" },
  currentPlan: ["Investigate", "Implement"],
  filesTouched: ["src/auth.ts"],
})
assert("fresh save sets title", first.task.title === "Fix auth")
assert("fresh save sets status", first.task.status === "in_progress")
assert("fresh save arrays default to empty", Array.isArray(first.completedSteps))
assert("fresh save has version", first.version === 1)

// Test 2: Deep merge preserves existing task fields
const second = deepMerge(first, {
  task: { status: "blocked" },
  blockers: ["Waiting on API key"],
})
assert("deep merge keeps title from first save", second.task.title === "Fix auth")
assert("deep merge updates status", second.task.status === "blocked")
assert("deep merge keeps plan from first save", second.currentPlan[0] === "Investigate")

// Test 3: Partial update doesn't clobber arrays
const third = deepMerge(second, {
  completedSteps: ["Investigate"],
  nextSteps: ["Get API key", "Implement"],
})
assert("partial update adds completedSteps", third.completedSteps[0] === "Investigate")
assert("partial merge keeps blockers", third.blockers[0] === "Waiting on API key")
assert("partial merge keeps plan", third.currentPlan[0] === "Investigate")

// Test 4: Status progression
const fourth = deepMerge(third, {
  task: { status: "done" },
  summary: "Auth fix complete",
})
assert("status progression", fourth.task.status === "done")
assert("summary set", fourth.summary === "Auth fix complete")

// Test 5: Atomic write test using temp file + rename
async function testAtomicWrite() {
  const dir = join(tmpdir(), "cp-test-" + Date.now())
  await mkdir(dir, { recursive: true })
  const file = join(dir, "checkpoint.json")
  const data = { version: 1, updatedAt: new Date().toISOString(), task: { title: "test" } }

  // Write atomically
  const tmp = file + ".tmp." + Date.now()
  await writeFile(tmp, JSON.stringify(data))
  await import("node:fs/promises").then(m => m.rename(tmp, file))

  const loaded = JSON.parse(await readFile(file, "utf8"))
  assert("atomic write produces valid file", loaded.task.title === "test")
  assert("temp file cleaned up after rename", !await import("node:fs").then(m => m.existsSync(tmp)))

  await rm(dir, { recursive: true, force: true })
}

await testAtomicWrite()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
