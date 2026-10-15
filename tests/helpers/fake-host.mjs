/**
 * Minimal fake of the OpenCode V2 plugin host, shared by the plugin-wiring and
 * interoperability suites.
 *
 * It models the parts of the host the plugin contracts on: a shared tool
 * registry, hook registries that preserve registration order, an event stream,
 * and per-plugin options with one shared location. It deliberately does NOT model
 * behaviour the host does not document, such as whether one plugin's throwing
 * hook prevents later hooks from running.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function makeEventStream() {
  const queue = []
  let resolver = null
  let closed = false
  return {
    push(event) {
      if (resolver) {
        const resolve = resolver
        resolver = null
        resolve({ value: event, done: false })
      } else queue.push(event)
    },
    close() {
      closed = true
      if (resolver) {
        const resolve = resolver
        resolver = null
        resolve({ value: undefined, done: true })
      }
    },
    subscribe({ signal } = {}) {
      const iterator = {
        async next() {
          if (queue.length > 0) return { value: queue.shift(), done: false }
          if (closed || signal?.aborted) return { value: undefined, done: true }
          return new Promise((resolve) => {
            resolver = resolve
            signal?.addEventListener(
              "abort",
              () => {
                resolver = null
                resolve({ value: undefined, done: true })
              },
              { once: true },
            )
          })
        },
        async return() {
          closed = true
          return { value: undefined, done: true }
        },
      }
      return { [Symbol.asyncIterator]: () => iterator }
    },
  }
}

/**
 * @param {object} [init]
 * @param {string} [init.projectID]      project id reported for sessions
 * @param {object} [init.options]        plugin options for the primary context
 * @param {string[]} [init.sessionIDs]   extra session ids to map into this host
 */
export function makeHost(init = {}) {
  const dir = mkdtempSync(join(tmpdir(), "co-host-"))
  const projectDirectory = init.projectDirectory ?? join(dir, "project")
  const databasePath = init.databasePath ?? join(dir, "checkpoints.db")
  const defaultProjectID = init.projectID ?? "proj-1"

  const tools = new Map()
  const hooks = new Map()
  const stream = makeEventStream()
  const projects = new Map()
  const sessionDirectories = {}
  const state = { transformCalls: 0 }

  function registerHook(name, callback) {
    const list = hooks.get(name) ?? []
    list.push(callback)
    hooks.set(name, list)
    return { dispose: async () => {} }
  }

  function makeToolEditor(callback) {
    callback({
      add: (definition) => tools.set(definition.name, definition),
      list: () => [...tools.values()],
      get: (id) => tools.get(id),
      remove: (id) => tools.delete(id),
      namespace: () => {},
      update: (id, update) => {
        const found = tools.get(id)
        if (found) update(found)
      },
    })
  }

  /** One context per plugin: shared registries, per-plugin options. */
  function contextFor(options = {}) {
    return {
      app: { name: "opencode", version: "2.0.21", channel: "test" },
      location: {
        directory: projectDirectory,
        project: { id: defaultProjectID, directory: projectDirectory, canonical: projectDirectory },
      },
      options,
      tool: {
        async transform(callback) {
          state.transformCalls++
          makeToolEditor(callback)
          return { dispose: async () => {} }
        },
        async list() {
          return [...tools.values()]
        },
        async hook(name, callback) {
          return registerHook(name, callback)
        },
        async reload() {},
      },
      session: {
        async get({ sessionID }) {
          return {
            id: sessionID,
            projectID: projects.get(sessionID) ?? defaultProjectID,
            title: `session ${sessionID}`,
            location: { directory: sessionDirectories[sessionID] ?? projectDirectory },
          }
        },
        async hook(name, callback) {
          return registerHook(name, callback)
        },
      },
      event: { subscribe: (input) => stream.subscribe(input) },
    }
  }

  return {
    dir,
    projectDirectory,
    databasePath,
    stream,
    projects,
    sessionDirectories,
    tools,
    hooks,
    get transformCalls() {
      return state.transformCalls
    },
    contextFor,
    /** First registered callback for a hook name, or undefined. */
    hookFor(name) {
      return hooks.get(name)?.[0]
    },
    hooksFor(name) {
      return hooks.get(name) ?? []
    },
    /**
     * Invoke every callback registered for a hook in registration order.
     * `isolate: false` models a host that stops at the first throw, which is the
     * pessimistic case for the plugins under test.
     */
    async runHooks(name, event, { isolate = true } = {}) {
      const errors = []
      for (const callback of this.hooksFor(name)) {
        try {
          await callback(event)
        } catch (error) {
          errors.push(error)
          if (!isolate) break
        }
      }
      return errors
    },
    cleanup() {
      stream.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function toolContext(sessionID) {
  return {
    sessionID,
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

export async function callTool(host, name, input = {}, sessionID = "ses_a") {
  const tool = host.tools.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  const result = await tool.execute(input, toolContext(sessionID))
  return result.content === undefined ? result : JSON.parse(result.content)
}
