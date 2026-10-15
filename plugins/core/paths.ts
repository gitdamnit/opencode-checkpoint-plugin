/**
 * Platform-appropriate storage locations. Pure: takes platform/env/home as
 * inputs so the behaviour is testable on any host.
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const APP_DIR_NAME = "checkpoint-orchestrator"
export const DB_FILE_NAME = "checkpoints.db"
export const DB_PATH_ENV = "CHECKPOINT_ORCHESTRATOR_DB"

export interface PathContext {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Directory that holds the authoritative database. Deliberately outside any
 * project working tree so checkpoints are never committed to Git.
 */
export function defaultDataRoot(ctx: PathContext = {}): string {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const home = ctx.home ?? homedir()

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA) ?? join(home, "AppData", "Roaming")
    return join(appData, "opencode", APP_DIR_NAME)
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "opencode", APP_DIR_NAME)
  }
  const xdg = nonEmpty(env.XDG_DATA_HOME) ?? join(home, ".local", "share")
  return join(xdg, "opencode", APP_DIR_NAME)
}

/**
 * Resolution order: explicit plugin option, then environment override, then the
 * platform default. `:memory:` is passed through for tests.
 */
export function resolveDatabasePath(override?: string, ctx: PathContext = {}): string {
  const env = ctx.env ?? process.env
  const candidate = nonEmpty(override) ?? nonEmpty(env[DB_PATH_ENV])
  if (candidate) return candidate
  return join(defaultDataRoot(ctx), DB_FILE_NAME)
}

/** Create the parent directory for a database file with owner-only permissions. */
export function ensureDatabaseDirectory(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
}
