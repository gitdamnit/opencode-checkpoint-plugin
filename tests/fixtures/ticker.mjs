// Child process used by tests/store.test.js to prove that concurrent prompt
// ticks cannot lose an increment.
// usage: node ticker.mjs <dbPath> <projectID> <sessionID> <ticks> <autosaveEvery>
import { CheckpointStore } from "../../dist/core/store.js"
import { CheckpointService, DEFAULT_SERVICE_OPTIONS } from "../../dist/core/service.js"

const [dbPath, projectID, sessionID, ticksRaw, limitRaw] = process.argv.slice(2)
const ticks = Number(ticksRaw ?? 10)

const store = new CheckpointStore(dbPath)
const service = new CheckpointService(store, {
  ...DEFAULT_SERVICE_OPTIONS,
  autosaveEvery: Number(limitRaw ?? 1000),
})
const ref = { sessionID, projectID, projectDirectory: `/tmp/${projectID}` }
service.ensure(ref)

for (let i = 0; i < ticks; i++) service.tickPrompt(ref)

store.close()
console.log(`ticker ${sessionID} ticked ${ticks}`)
