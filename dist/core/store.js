/**
 * SQLite-backed checkpoint storage.
 *
 * Design notes:
 *  - `node:sqlite` (DatabaseSync) is the authoritative driver. It is built in to
 *    Node >= 22.5 and to Bun >= 1.4, which is the runtime OpenCode uses, so the
 *    package has no native build step and no ABI to match when installed.
 *  - Every read/write is scoped by `session_id`, which is what makes session
 *    isolation an invariant of the storage layer rather than of the callers.
 *  - Writes that must not interleave (checkpoint + snapshot + prune) run inside
 *    a single transaction; the transaction helper is re-entrant via savepoints.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CONNECTION_PRAGMAS, LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import { emptyRuntime, } from "./types.js";
import { normalizeData, nowIso } from "./util.js";
import { ensureDatabaseDirectory } from "./paths.js";
const DEFAULT_HISTORY_LIMIT = 10;
const INTEGRITY_CHECK_MAX_BYTES = 64 * 1024 * 1024;
/** node:sqlite only binds null/number/bigint/string/typed arrays. */
function nz(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === "boolean")
        return value ? 1 : 0;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
        return value;
    return String(value);
}
/**
 * Session ids are the isolation key. A missing or malformed id must fail loudly:
 * binding `null` would scope the statement to nothing (or, in a write path, be
 * mistaken for a successful no-op) instead of surfacing the caller's bug.
 */
function requireId(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}
function sleepSync(ms) {
    try {
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
    catch {
        /* Atomics unavailable in this context: fall through, busy_timeout still applies. */
    }
}
function isBusy(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_BUSY|database is locked|database table is locked/i.test(message);
}
export class CheckpointStore {
    db;
    dbPath;
    statements = new Map();
    historyLimit;
    txDepth = 0;
    closed = false;
    journalMode;
    constructor(dbPath, options = {}) {
        this.dbPath = dbPath;
        this.historyLimit = Math.max(1, Math.trunc(options.historyLimit ?? DEFAULT_HISTORY_LIMIT));
        if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:")) {
            ensureDatabaseDirectory(dbPath);
        }
        this.db = new DatabaseSync(dbPath);
        for (const pragma of CONNECTION_PRAGMAS) {
            try {
                this.db.exec(pragma);
            }
            catch {
                /* pragma unsupported in this runtime: non-fatal */
            }
        }
        let mode = "unknown";
        try {
            this.db.exec("PRAGMA journal_mode = WAL");
            const row = this.db.prepare("PRAGMA journal_mode").get();
            mode = String(row?.journal_mode ?? "unknown");
        }
        catch {
            /* falls back to the runtime default (delete/truncate) */
        }
        this.journalMode = mode;
        this.applyMigrations();
        this.restrictFilePermissions();
        if (options.integrityCheckOnOpen !== false)
            this.verifyOnOpen();
    }
    // ---------------------------------------------------------------- lifecycle
    /** Actual journal mode in use; "wal" on supported local filesystems. */
    get journalModeInUse() {
        return this.journalMode;
    }
    get path() {
        return this.dbPath;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.statements.clear();
        try {
            this.db.close();
        }
        catch {
            /* already closed by the runtime */
        }
    }
    // ---------------------------------------------------------------- migrations
    prepare(sql) {
        let stmt = this.statements.get(sql);
        if (!stmt) {
            stmt = this.db.prepare(sql);
            this.statements.set(sql, stmt);
        }
        return stmt;
    }
    get schemaVersion() {
        const row = this.db.prepare("PRAGMA user_version").get();
        return Number(row?.user_version ?? 0);
    }
    applyMigrations() {
        // The entire upgrade runs inside one BEGIN IMMEDIATE transaction that
        // re-reads `user_version` after acquiring the write lock. Two processes
        // opening a brand-new database at the same instant both observe version 0
        // before either commits; without the in-transaction re-read the loser
        // replays `CREATE TABLE` and dies with "table projects already exists",
        // leaving the plugin inert. Doing the whole run in one transaction also
        // means a multi-step upgrade is all-or-nothing.
        this.transaction(() => {
            let current = this.schemaVersion;
            for (const migration of MIGRATIONS) {
                if (migration.version <= current)
                    continue;
                for (const statement of migration.statements)
                    this.db.exec(statement);
                this.db.exec(`PRAGMA user_version = ${migration.version}`);
                current = migration.version;
            }
            if (current !== LATEST_SCHEMA_VERSION) {
                throw new Error(`Checkpoint database schema is v${current} but this build expects v${LATEST_SCHEMA_VERSION}. ` +
                    `Refusing to run with an incompatible database: ${this.dbPath}`);
            }
        });
    }
    // ---------------------------------------------------------------- integrity
    verifyOnOpen() {
        try {
            if (this.dbPath !== ":memory:" && !this.dbPath.startsWith("file::memory:")) {
                if (!existsSync(this.dbPath))
                    return;
                if (statSync(this.dbPath).size > INTEGRITY_CHECK_MAX_BYTES)
                    return;
            }
            const result = this.integrityCheck();
            if (result !== "ok") {
                console.error(`[checkpoint-orchestrator] integrity_check reported: ${result}`);
            }
        }
        catch {
            /* verification must never prevent startup */
        }
    }
    integrityCheck() {
        const row = this.db.prepare("PRAGMA integrity_check").get();
        return String(row?.integrity_check ?? "unknown");
    }
    foreignKeyCheck() {
        const rows = this.db.prepare("PRAGMA foreign_key_check").all();
        return rows.length;
    }
    restrictFilePermissions() {
        if (this.dbPath === ":memory:" || this.dbPath.startsWith("file::memory:"))
            return;
        for (const suffix of ["", "-wal", "-shm"]) {
            const target = this.dbPath + suffix;
            try {
                if (existsSync(target))
                    chmodSync(target, 0o600);
            }
            catch {
                /* best effort: permissions may be managed by the platform */
            }
        }
    }
    // --------------------------------------------------------------- transactions
    beginImmediate() {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.db.exec("BEGIN IMMEDIATE");
                return;
            }
            catch (error) {
                lastError = error;
                if (!isBusy(error))
                    throw error;
                sleepSync(25 * (attempt + 1));
            }
        }
        throw lastError;
    }
    /** Run `fn` atomically. Nested calls use savepoints. */
    transaction(fn) {
        if (this.txDepth > 0) {
            const name = `co_sp_${this.txDepth}`;
            this.db.exec(`SAVEPOINT ${name}`);
            this.txDepth++;
            try {
                const result = fn();
                this.db.exec(`RELEASE ${name}`);
                return result;
            }
            catch (error) {
                try {
                    this.db.exec(`ROLLBACK TO ${name}`);
                    this.db.exec(`RELEASE ${name}`);
                }
                catch {
                    /* preserve the original error */
                }
                throw error;
            }
            finally {
                this.txDepth--;
            }
        }
        this.beginImmediate();
        this.txDepth = 1;
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch {
                /* preserve the original error */
            }
            throw error;
        }
        finally {
            this.txDepth = 0;
        }
    }
    // -------------------------------------------------------------- projects/sessions
    ensureProject(projectID, directory, canonical) {
        const at = nowIso();
        this.prepare(`INSERT INTO projects (id, directory, canonical, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         directory = excluded.directory,
         canonical = COALESCE(excluded.canonical, projects.canonical),
         updated_at = excluded.updated_at`).run(nz(projectID), nz(directory), nz(canonical), nz(at), nz(at));
    }
    ensureSession(ref) {
        this.ensureProject(ref.projectID, ref.projectDirectory);
        this.upsertSession(ref);
    }
    /**
     * Record a project when the caller knows its id but not its directory. This
     * must never overwrite a directory an authoritative caller already stored, so
     * it only stubs the row in (the id doubles as a placeholder directory) and a
     * later `ensureProject` fills in the real value.
     */
    ensureProjectPlaceholder(projectID) {
        const at = nowIso();
        this.prepare(`INSERT INTO projects (id, directory, canonical, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(nz(projectID), nz(projectID), nz(at), nz(at));
    }
    upsertSession(ref) {
        const at = nowIso();
        this.prepare(`INSERT INTO sessions (id, project_id, parent_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
         title = COALESCE(excluded.title, sessions.title),
         updated_at = excluded.updated_at`).run(nz(ref.sessionID), nz(ref.projectID), nz(ref.parentID ?? null), nz(ref.title ?? null), nz(at), nz(at));
    }
    getSession(sessionID) {
        const row = this.prepare("SELECT id, project_id, parent_id, title FROM sessions WHERE id = ?").get(requireId(sessionID, "sessionID"));
        if (!row)
            return null;
        return { id: row.id, projectID: row.project_id, parentID: row.parent_id, title: row.title };
    }
    listSessionIds() {
        const rows = this.prepare("SELECT id FROM sessions ORDER BY created_at").all();
        return rows.map((row) => row.id);
    }
    // ---------------------------------------------------------------- checkpoints
    rowToData(row) {
        const parseArray = (value) => {
            try {
                const parsed = JSON.parse(String(value ?? "[]"));
                return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
            }
            catch {
                return [];
            }
        };
        return {
            version: Number(row.schema_version ?? 0),
            updatedAt: String(row.updated_at ?? ""),
            task: {
                title: row.title === null || row.title === undefined ? undefined : String(row.title),
                objective: row.objective === null || row.objective === undefined ? undefined : String(row.objective),
                status: (row.status ?? undefined),
            },
            summary: row.summary === null || row.summary === undefined ? undefined : String(row.summary),
            currentPlan: parseArray(row.current_plan),
            completedSteps: parseArray(row.completed_steps),
            nextSteps: parseArray(row.next_steps),
            blockers: parseArray(row.blockers),
            filesTouched: parseArray(row.files_touched),
            notes: parseArray(row.notes),
        };
    }
    loadCheckpoint(sessionID) {
        const row = this.prepare(`SELECT title, objective, status, summary, current_plan, completed_steps, next_steps,
              blockers, files_touched, notes, schema_version, synthesized, created_at, updated_at
       FROM checkpoints WHERE session_id = ?`).get(requireId(sessionID, "sessionID"));
        if (!row)
            return null;
        return {
            data: this.rowToData(row),
            synthesized: Number(row.synthesized ?? 0) === 1,
            createdAt: String(row.created_at ?? ""),
            updatedAt: String(row.updated_at ?? ""),
        };
    }
    /** Insert or update the session's single live checkpoint. */
    saveCheckpoint(input) {
        const { data } = input;
        const now = data.updatedAt || nowIso();
        this.ensureSessionIfMissing(input.sessionID, input.projectID);
        this.prepare(`INSERT INTO checkpoints (
         session_id, project_id, title, objective, status, summary, current_plan, completed_steps,
         next_steps, blockers, files_touched, notes, schema_version, synthesized, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title,
         objective = excluded.objective,
         status = excluded.status,
         summary = excluded.summary,
         current_plan = excluded.current_plan,
         completed_steps = excluded.completed_steps,
         next_steps = excluded.next_steps,
         blockers = excluded.blockers,
         files_touched = excluded.files_touched,
         notes = excluded.notes,
         schema_version = excluded.schema_version,
         synthesized = excluded.synthesized,
         updated_at = excluded.updated_at`).run(requireId(input.sessionID, "sessionID"), requireId(input.projectID, "projectID"), nz(data.task?.title ?? null), nz(data.task?.objective ?? null), nz(data.task?.status ?? null), nz(data.summary ?? null), nz(JSON.stringify(data.currentPlan ?? [])), nz(JSON.stringify(data.completedSteps ?? [])), nz(JSON.stringify(data.nextSteps ?? [])), nz(JSON.stringify(data.blockers ?? [])), nz(JSON.stringify(data.filesTouched ?? [])), nz(JSON.stringify(data.notes ?? [])), nz(data.version), nz(input.synthesized ? 1 : 0), nz(now), nz(now));
    }
    /**
     * The store never creates projects implicitly from an unknown id: a checkpoint
     * must belong to a known session, which is what keeps cross-session writes
     * impossible.
     */
    ensureSessionIfMissing(sessionID, projectID) {
        const existing = this.getSession(sessionID);
        if (existing)
            return;
        this.ensureProjectPlaceholder(projectID);
        this.upsertSession({ sessionID, projectID, projectDirectory: projectID });
    }
    clearSession(sessionID) {
        return this.transaction(() => {
            const checkpoints = Number(this.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(requireId(sessionID, "sessionID")).changes ?? 0);
            const snapshots = Number(this.prepare("DELETE FROM snapshots WHERE session_id = ?").run(requireId(sessionID, "sessionID")).changes ?? 0);
            const runtime = Number(this.prepare("DELETE FROM session_runtime WHERE session_id = ?").run(requireId(sessionID, "sessionID")).changes ?? 0);
            return { checkpoints, snapshots, runtime };
        });
    }
    // ------------------------------------------------------------------ snapshots
    rowToSnapshot(row) {
        let data;
        try {
            data = normalizeData(JSON.parse(String(row.payload ?? "{}")));
        }
        catch {
            data = normalizeData({});
        }
        return {
            id: Number(row.id),
            name: String(row.name),
            kind: String(row.kind),
            savedAt: String(row.captured_at),
            schemaVersion: Number(row.schema_version ?? 0),
            restoredAt: row.restored_at === null || row.restored_at === undefined ? null : String(row.restored_at),
            data,
        };
    }
    addSnapshot(input) {
        const savedAt = input.savedAt ?? input.data.updatedAt ?? nowIso();
        this.ensureSessionIfMissing(input.sessionID, input.projectID);
        this.prepare(`INSERT INTO snapshots (session_id, project_id, name, kind, captured_at, payload, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, name) DO UPDATE SET
         kind = excluded.kind,
         captured_at = excluded.captured_at,
         payload = excluded.payload,
         schema_version = excluded.schema_version,
         restored_at = NULL`).run(requireId(input.sessionID, "sessionID"), requireId(input.projectID, "projectID"), nz(input.name), nz(input.kind), nz(savedAt), nz(JSON.stringify(input.data)), nz(input.data.version));
        const row = this.prepare("SELECT id FROM snapshots WHERE session_id = ? AND name = ?").get(requireId(input.sessionID, "sessionID"), nz(input.name));
        return Number(row?.id ?? 0);
    }
    listSnapshots(sessionID, limit) {
        const limitValue = limit === undefined ? -1 : Math.max(0, Math.trunc(limit));
        const rows = this.prepare(`SELECT id, name, kind, captured_at, payload, schema_version, restored_at
       FROM snapshots WHERE session_id = ?
       ORDER BY captured_at DESC, id DESC
       LIMIT ?`).all(requireId(sessionID, "sessionID"), nz(limitValue));
        return rows.map((row) => this.rowToSnapshot(row));
    }
    getSnapshot(sessionID, name) {
        const row = this.prepare(`SELECT id, name, kind, captured_at, payload, schema_version, restored_at
       FROM snapshots WHERE session_id = ? AND name = ?`).get(requireId(sessionID, "sessionID"), nz(name));
        return row ? this.rowToSnapshot(row) : null;
    }
    latestSnapshot(sessionID) {
        const rows = this.listSnapshots(sessionID, 1);
        return rows.length > 0 ? rows[0] : null;
    }
    countSnapshots(sessionID) {
        const row = this.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE session_id = ?").get(requireId(sessionID, "sessionID"));
        return Number(row?.c ?? 0);
    }
    markSnapshotRestored(sessionID, name, at = nowIso()) {
        this.prepare("UPDATE snapshots SET restored_at = ? WHERE session_id = ? AND name = ?").run(nz(at), requireId(sessionID, "sessionID"), nz(name));
    }
    /**
     * Keep the newest `limit` snapshots, but never remove the most recent
     * pre-restore snapshot: that is the user's undo point.
     */
    pruneSnapshots(sessionID, limit = this.historyLimit) {
        const keep = Math.max(1, Math.trunc(limit));
        const result = this.prepare(`DELETE FROM snapshots
       WHERE session_id = ?
         AND id NOT IN (
           SELECT id FROM snapshots WHERE session_id = ?
           ORDER BY captured_at DESC, id DESC LIMIT ?
         )
         AND id <> COALESCE((
           SELECT id FROM snapshots WHERE session_id = ? AND kind = 'pre-restore'
           ORDER BY captured_at DESC, id DESC LIMIT 1
         ), -1)`).run(requireId(sessionID, "sessionID"), requireId(sessionID, "sessionID"), nz(keep), requireId(sessionID, "sessionID"));
        return Number(result.changes ?? 0);
    }
    // ------------------------------------------------------------ runtime counters
    getRuntime(sessionID) {
        const row = this.prepare("SELECT messages_since_save, last_injected_hash, last_autosave_at FROM session_runtime WHERE session_id = ?").get(requireId(sessionID, "sessionID"));
        if (!row)
            return emptyRuntime();
        return {
            messagesSinceSave: Number(row.messages_since_save ?? 0),
            lastInjectedHash: String(row.last_injected_hash ?? ""),
            lastAutosaveAt: row.last_autosave_at ?? null,
        };
    }
    setRuntime(sessionID, projectID, update) {
        // Read-modify-write in one transaction: two processes ticking the same
        // session must not lose each other's counter update.
        this.transaction(() => {
            this.ensureSessionIfMissing(sessionID, projectID);
            const current = this.getRuntime(sessionID);
            const next = { ...current, ...update };
            this.prepare(`INSERT INTO session_runtime (session_id, messages_since_save, last_injected_hash, last_autosave_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           messages_since_save = excluded.messages_since_save,
           last_injected_hash = excluded.last_injected_hash,
           last_autosave_at = excluded.last_autosave_at,
           updated_at = excluded.updated_at`).run(requireId(sessionID, "sessionID"), nz(next.messagesSinceSave), nz(next.lastInjectedHash), nz(next.lastAutosaveAt), nz(nowIso()));
        });
    }
    // -------------------------------------------------------------------- ledger
    hasMigration(id) {
        const row = this.prepare("SELECT 1 AS present FROM migrations WHERE id = ?").get(nz(id));
        return row !== undefined;
    }
    recordMigration(id, projectID, details) {
        this.prepare("INSERT OR REPLACE INTO migrations (id, project_id, applied_at, details) VALUES (?, ?, ?, ?)").run(nz(id), nz(projectID), nz(nowIso()), nz(details === undefined ? null : JSON.stringify(details)));
    }
}
