// Child process used by tests/store.test.js to exercise multi-process access.
// usage: node writer.mjs <dbPath> <projectID> <sessionID> <count>
import { CheckpointStore } from "../../dist/core/store.js"
import { deepMerge } from "../../dist/core/util.js"

const [dbPath, projectID, sessionID, countRaw] = process.argv.slice(2)
const count = Number(countRaw ?? 10)

const store = new CheckpointStore(dbPath)
store.ensureSession({ sessionID, projectID, projectDirectory: `/tmp/${projectID}` })

for (let i = 0; i < count; i++) {
  store.transaction(() => {
    store.saveCheckpoint({
      sessionID,
      projectID,
      data: deepMerge(null, {
        task: { title: `${sessionID}-write-${i}`, status: "in_progress" },
        nextSteps: [`step-${i}`],
      }),
    })
    store.addSnapshot({
      sessionID,
      projectID,
      name: `${sessionID}-snap-${i}`,
      kind: "auto",
      data: deepMerge(null, { task: { title: `${sessionID}-write-${i}` } }),
    })
  })
}

store.close()
console.log(`writer ${sessionID} wrote ${count}`)
