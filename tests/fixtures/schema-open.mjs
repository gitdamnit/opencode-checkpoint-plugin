// Child process used by tests/store.test.js: opens (and therefore migrates) a
// brand-new database, then prints its schema version. Several copies of this run
// at once to prove concurrent first-open is safe.
// usage: node schema-open.mjs <dbPath>
import { CheckpointStore } from "../../dist/core/store.js"

const [dbPath] = process.argv.slice(2)
const store = new CheckpointStore(dbPath)
console.log(String(store.schemaVersion))
store.close()
