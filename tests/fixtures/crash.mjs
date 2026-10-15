// Child process used by tests/store.test.js: dies with SIGKILL in the middle of
// an open transaction so WAL recovery can be verified against a real crash.
// usage: node crash.mjs <dbPath> <projectID> <sessionID>
import { CheckpointStore } from "../../dist/core/store.js"
import { deepMerge } from "../../dist/core/util.js"

const [dbPath, projectID, sessionID] = process.argv.slice(2)
const store = new CheckpointStore(dbPath)
store.ensureSession({ sessionID, projectID, projectDirectory: `/tmp/${projectID}` })

// A committed write that must survive the crash.
store.saveCheckpoint({
  sessionID,
  projectID,
  data: deepMerge(null, { task: { title: "committed-before-crash", status: "in_progress" } }),
})

// An uncommitted write that must not survive it.
store.transaction(() => {
  store.saveCheckpoint({
    sessionID,
    projectID,
    data: deepMerge(null, { task: { title: "uncommitted", status: "done" }, completedSteps: ["must-roll-back"] }),
  })
  store.addSnapshot({
    sessionID,
    projectID,
    name: "uncommitted-snapshot",
    kind: "auto",
    data: deepMerge(null, { task: { title: "uncommitted" } }),
  })
  process.kill(process.pid, "SIGKILL")
})
