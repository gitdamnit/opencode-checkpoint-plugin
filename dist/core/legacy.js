/**
 * Migration of the pre-SQLite project-level JSON checkpoints.
 *
 * Guarantees:
 *  - originals are copied, never deleted or rewritten;
 *  - imports run in a single transaction, so a failure can be retried;
 *  - a ledger row makes the import idempotent across restarts;
 *  - legacy data is never attached to an arbitrary active session. It lands in
 *    an explicitly named `legacy::<projectID>` namespace, and moving it into a
 *    real session is an explicit, opt-in operation.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeData, nowIso } from "./util.js";
export const LEGACY_STATE_DIR = ".opencode/state";
export const LEGACY_CHECKPOINT_FILE = "checkpoint.json";
export const LEGACY_HISTORY_FILE = "checkpoint-history.json";
export const LEGACY_HANDOFF_FILE = "handoff.md";
export function legacySessionId(projectID) {
    return `legacy::${projectID}`;
}
export function migrationLedgerId(projectID) {
    return `legacy-json:${projectID}`;
}
export function legacyStateDir(projectDirectory) {
    return join(projectDirectory, LEGACY_STATE_DIR);
}
function readJsonFile(path) {
    if (!existsSync(path))
        return { kind: "missing", value: null };
    try {
        return { kind: "ok", value: JSON.parse(readFileSync(path, "utf8")) };
    }
    catch (error) {
        return { kind: "error", value: null, error: error instanceof Error ? error.message : String(error) };
    }
}
export function readLegacyState(projectDirectory) {
    const dir = legacyStateDir(projectDirectory);
    const checkpointPath = join(dir, LEGACY_CHECKPOINT_FILE);
    const historyPath = join(dir, LEGACY_HISTORY_FILE);
    const checkpointRead = readJsonFile(checkpointPath);
    const historyRead = readJsonFile(historyPath);
    const unreadable = [];
    if (checkpointRead.kind === "error")
        unreadable.push(`${LEGACY_CHECKPOINT_FILE}: ${checkpointRead.error}`);
    if (historyRead.kind === "error")
        unreadable.push(`${LEGACY_HISTORY_FILE}: ${historyRead.error}`);
    const checkpoint = checkpointRead.kind === "ok" ? normalizeData(checkpointRead.value) : null;
    const snapshots = [];
    if (historyRead.kind === "ok") {
        const rawSnapshots = historyRead.value?.snapshots;
        if (Array.isArray(rawSnapshots)) {
            for (const entry of rawSnapshots) {
                if (typeof entry !== "object" || entry === null)
                    continue;
                const record = entry;
                const name = typeof record.name === "string" && record.name.length > 0 ? record.name : `legacy-${snapshots.length + 1}`;
                const savedAt = typeof record.savedAt === "string" && record.savedAt.length > 0 ? record.savedAt : nowIso();
                snapshots.push({ name, savedAt, data: normalizeData(record.data) });
            }
        }
    }
    let checkpointBytes = 0;
    if (existsSync(checkpointPath)) {
        try {
            checkpointBytes = Buffer.byteLength(readFileSync(checkpointPath, "utf8"));
        }
        catch {
            checkpointBytes = 0;
        }
    }
    const present = checkpointRead.kind !== "missing" || historyRead.kind !== "missing";
    return { present, checkpoint, snapshots, checkpointBytes, unreadable };
}
/** Copy the legacy artefacts aside. Originals are left untouched. */
export function backupLegacyFiles(projectDirectory, stamp) {
    const dir = legacyStateDir(projectDirectory);
    const created = [];
    for (const name of [LEGACY_CHECKPOINT_FILE, LEGACY_HISTORY_FILE, LEGACY_HANDOFF_FILE]) {
        const source = join(dir, name);
        if (!existsSync(source))
            continue;
        const target = join(dir, `${name}.legacy-backup-${stamp}`);
        try {
            copyFileSync(source, target);
            created.push(target);
        }
        catch {
            /* backups are best effort; the import itself is still transactional */
        }
    }
    return created;
}
export function importLegacyState(store, options) {
    if (options.enabled === false) {
        return { imported: false, reason: "disabled", snapshotCount: 0, backedUp: [], warnings: [] };
    }
    const ledgerId = migrationLedgerId(options.projectID);
    if (store.hasMigration(ledgerId)) {
        return { imported: false, reason: "already-imported", snapshotCount: 0, backedUp: [], warnings: [] };
    }
    const state = readLegacyState(options.projectDirectory);
    if (!state.present) {
        return { imported: false, reason: "no-legacy-state", snapshotCount: 0, backedUp: [], warnings: [] };
    }
    if (!state.checkpoint && state.snapshots.length === 0) {
        // Files exist but nothing usable was in them. Report rather than pretend the
        // project never had legacy state.
        return {
            imported: false,
            reason: state.unreadable.length > 0 ? "unreadable-legacy-state" : "empty-legacy-state",
            snapshotCount: 0,
            backedUp: [],
            warnings: state.unreadable,
        };
    }
    const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
    const backedUp = backupLegacyFiles(options.projectDirectory, stamp);
    const sessionID = legacySessionId(options.projectID);
    const ref = {
        sessionID,
        projectID: options.projectID,
        projectDirectory: options.projectDirectory,
        title: "Legacy project-level checkpoint (imported)",
    };
    store.transaction(() => {
        store.ensureSession(ref);
        if (state.checkpoint) {
            store.saveCheckpoint({
                sessionID,
                projectID: options.projectID,
                data: state.checkpoint,
                synthesized: false,
            });
            store.addSnapshot({
                sessionID,
                projectID: options.projectID,
                name: `legacy-live-${stamp}`,
                kind: "legacy",
                data: state.checkpoint,
                savedAt: state.checkpoint.updatedAt,
            });
        }
        const seen = new Set();
        for (const snapshot of state.snapshots) {
            let name = snapshot.name;
            let suffix = 2;
            while (seen.has(name))
                name = `${snapshot.name}#${suffix++}`;
            seen.add(name);
            store.addSnapshot({
                sessionID,
                projectID: options.projectID,
                name,
                kind: "legacy",
                data: snapshot.data,
                savedAt: snapshot.savedAt,
            });
        }
        store.pruneSnapshots(sessionID, options.historyLimit);
        store.recordMigration(ledgerId, options.projectID, {
            source: options.projectDirectory,
            snapshots: state.snapshots.length,
            backedUp,
            warnings: state.unreadable,
        });
    });
    return {
        imported: true,
        reason: "imported",
        snapshotCount: state.snapshots.length,
        backedUp,
        warnings: state.unreadable,
    };
}
