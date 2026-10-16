// Child process used by tests/store.test.js: races other copies of itself to
// import the same legacy JSON, proving the ledger check is inside the write
// transaction and the import happens exactly once.
// usage: node importer.mjs <dbPath> <projectDirectory> <projectID>
import { CheckpointStore } from "../../dist/core/store.js"
import { importLegacyState } from "../../dist/core/legacy.js"

const [dbPath, projectDirectory, projectID] = process.argv.slice(2)
const store = new CheckpointStore(dbPath)
const result = importLegacyState(store, { projectID, projectDirectory, historyLimit: 10 })
store.close()
console.log(JSON.stringify(result))
