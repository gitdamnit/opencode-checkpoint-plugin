/**
 * Checkpoint Orchestrator — OpenCode V2 plugin.
 *
 * This file is wiring only: it resolves the calling session, registers tools and
 * hooks, and delegates every decision to `core/service.ts`, which is covered by
 * the test suite. All persistence lives in SQLite (see `core/store.ts`).
 */
import { Plugin } from "@opencode/plugin";
import { HANDOFF_DIR } from "./core/handoff.js";
import { legacySessionId } from "./core/legacy.js";
import { resolveDatabasePath } from "./core/paths.js";
import { CheckpointService, DEFAULT_SERVICE_OPTIONS, } from "./core/service.js";
import { CheckpointStore } from "./core/store.js";
import { MAX_ARRAY_ITEMS, MAX_SANITIZED_LENGTH, MAX_STRING_LENGTH, clampArray, clampInt, clampString, isStatus, } from "./core/util.js";
export const PLUGIN_ID = "gitdamnit.checkpoint-orchestrator";
export const PLUGIN_VERSION = "2.0.0";
// Namespaced default: a co-installed plugin sharing .opencode/ must never see
// our files, and we must never write into a directory we do not own.
const DEFAULT_HANDOFF_DIR = HANDOFF_DIR;
function objectSchema(properties, required = []) {
    return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
    };
}
function json(value) {
    return { content: JSON.stringify(value, null, 2) };
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export function resolveOptions(raw) {
    const options = raw ?? {};
    const historyLimit = clampInt(options.historyLimit, 1, 1000, DEFAULT_SERVICE_OPTIONS.historyLimit);
    let autosaveEvery = DEFAULT_SERVICE_OPTIONS.autosaveEvery;
    if (options.autosaveEvery === false)
        autosaveEvery = 0;
    else if (options.autosaveEvery !== undefined) {
        autosaveEvery = clampInt(options.autosaveEvery, 0, 1000, DEFAULT_SERVICE_OPTIONS.autosaveEvery);
    }
    let handoffDirectory = DEFAULT_HANDOFF_DIR;
    if (typeof options.handoffDir === "string" && options.handoffDir.trim().length > 0) {
        const candidate = options.handoffDir.trim().replace(/\\/g, "/");
        // Refuse absolute or parent-escaping paths: the export must stay inside the project.
        if (!candidate.startsWith("/") && !/^[A-Za-z]:/.test(candidate) && !candidate.split("/").includes("..")) {
            handoffDirectory = candidate.replace(/\/+$/, "");
        }
    }
    const databasePathOverride = typeof options.databasePath === "string" && options.databasePath.trim().length > 0
        ? options.databasePath.trim()
        : undefined;
    return {
        service: {
            historyLimit,
            handoffEnabled: options.handoff === false ? false : true,
            handoffDirectory,
            autosaveEvery,
            maxInjectionChars: clampInt(options.maxInjectionChars, 1000, 200_000, DEFAULT_SERVICE_OPTIONS.maxInjectionChars),
        },
        databasePath: resolveDatabasePath(databasePathOverride),
        databasePathOverride,
        legacyImport: options.legacyImport === "off" ? false : true,
    };
}
export function createLogger() {
    const prefix = "[checkpoint-orchestrator]";
    return {
        info: (message, extra) => console.log(prefix, message, extra ?? ""),
        warn: (message, extra) => console.warn(prefix, message, extra ?? ""),
        error: (message, extra) => console.error(prefix, message, extra ?? ""),
    };
}
/** Resolves the session -> project mapping that scopes every operation. */
export class SessionResolver {
    ctx;
    logger;
    cache = new Map();
    constructor(ctx, logger) {
        this.ctx = ctx;
        this.logger = logger;
    }
    fallback(sessionID) {
        const project = this.ctx.location.project;
        return {
            sessionID,
            projectID: project.id,
            projectDirectory: project.canonical ?? project.directory ?? this.ctx.location.directory,
        };
    }
    async resolve(sessionID) {
        const cached = this.cache.get(sessionID);
        if (cached)
            return cached;
        const base = this.fallback(sessionID);
        try {
            const info = (await this.ctx.session.get({ sessionID }));
            const projectID = typeof info?.projectID === "string" && info.projectID.length > 0 ? info.projectID : base.projectID;
            const sessionDirectory = info?.location && typeof info.location.directory === "string" && info.location.directory.length > 0
                ? info.location.directory
                : undefined;
            const project = this.ctx.location.project;
            // The plugin's own location is only authoritative for sessions that belong
            // to this project. For a session from another project, its own reported
            // location is the only trustworthy directory: using the plugin's project
            // root here would look for legacy state and write handoff files in the
            // wrong repository.
            const projectDirectory = projectID === project.id
                ? (project.canonical ?? project.directory ?? this.ctx.location.directory)
                : (sessionDirectory ?? this.ctx.location.directory);
            const ref = {
                sessionID,
                projectID,
                projectDirectory,
                parentID: typeof info?.parentID === "string" ? info.parentID : undefined,
                title: typeof info?.title === "string" ? info.title : undefined,
            };
            this.cache.set(sessionID, ref);
            return ref;
        }
        catch (error) {
            this.logger.warn("Could not resolve session metadata; using plugin location", {
                sessionID,
                error: messageOf(error),
            });
            this.cache.set(sessionID, base);
            return base;
        }
    }
    forget(sessionID) {
        this.cache.delete(sessionID);
    }
}
export function extractSessionID(event) {
    if (typeof event !== "object" || event === null)
        return null;
    const candidate = event;
    if (typeof candidate.sessionID === "string" && candidate.sessionID.length > 0)
        return candidate.sessionID;
    if (candidate.data && typeof candidate.data.sessionID === "string" && candidate.data.sessionID.length > 0) {
        return candidate.data.sessionID;
    }
    return null;
}
export default Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
        const resolved = resolveOptions(ctx.options);
        const logger = createLogger();
        let store = null;
        let storeError = null;
        try {
            store = new CheckpointStore(resolved.databasePath, { historyLimit: resolved.service.historyLimit });
        }
        catch (error) {
            storeError = messageOf(error);
            logger.error("Failed to open checkpoint database; plugin is inert until this is fixed", {
                databasePath: resolved.databasePath,
                error: storeError,
            });
        }
        const service = store ? new CheckpointService(store, resolved.service, logger) : null;
        const requirement = () => {
            if (!service)
                throw new Error(`Checkpoint storage unavailable: ${storeError ?? "unknown error"}`);
            return service;
        };
        logger.info("Loaded", {
            version: PLUGIN_VERSION,
            opencode: ctx.app.version,
            databasePath: store ? store.path : null,
            journalMode: store ? store.journalModeInUse : null,
            historyLimit: resolved.service.historyLimit,
            autosaveEvery: resolved.service.autosaveEvery,
        });
        const resolver = new SessionResolver(ctx, logger);
        const importedProjects = new Set();
        /** Legacy JSON is imported into its own namespace, once per project. */
        const ensureLegacyImported = (projectID, projectDirectory) => {
            if (!service || importedProjects.has(projectID))
                return;
            importedProjects.add(projectID);
            try {
                const result = service.importLegacy({ sessionID: legacySessionId(projectID), projectID, projectDirectory }, resolved.legacyImport);
                if (result.warnings.length > 0) {
                    logger.warn("Legacy checkpoint files exist but could not be fully read; they were left untouched", {
                        projectID,
                        warnings: result.warnings,
                    });
                }
                if (result.imported) {
                    logger.warn("Imported legacy JSON checkpoints into the legacy namespace", {
                        projectID,
                        snapshots: result.snapshotCount,
                        backedUp: result.backedUp.length,
                    });
                }
            }
            catch (error) {
                logger.error("Legacy checkpoint import failed; legacy files were left untouched", {
                    projectID,
                    error: messageOf(error),
                });
            }
        };
        if (service) {
            ensureLegacyImported(ctx.location.project.id, ctx.location.project.canonical ?? ctx.location.project.directory ?? ctx.location.directory);
        }
        // ------------------------------------------------------------------ tools
        const tools = [
            {
                name: "checkpoint_save",
                description: "Save or update this session's persistent task state for recovery or handoff. Fields are deep-merged, so a partial update never clobbers stored data. Paste only genuinely completed work into completedSteps. Optionally pass snapshotName to tag this save. State is stored per session and cannot be read by other sessions.",
                input: objectSchema({
                    title: { type: "string", description: "Short task title" },
                    objective: { type: "string", description: "What the task is trying to achieve" },
                    status: { type: "string", enum: ["not_started", "in_progress", "blocked", "done"] },
                    summary: { type: "string", description: "Free-form summary of where things stand" },
                    currentPlan: { type: "array", items: { type: "string" } },
                    completedSteps: { type: "array", items: { type: "string" } },
                    nextSteps: { type: "array", items: { type: "string" } },
                    blockers: { type: "array", items: { type: "string" } },
                    filesTouched: { type: "array", items: { type: "string" } },
                    notes: { type: "array", items: { type: "string" } },
                    snapshotName: { type: "string", description: "Optional name to tag this save as a restorable snapshot" },
                }),
                async execute(input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const svc = requirement();
                        const args = (input ?? {});
                        const snapshotName = clampString(args.snapshotName, 200);
                        const outcome = svc.save(ref, {
                            task: {
                                title: clampString(args.title, MAX_STRING_LENGTH),
                                objective: clampString(args.objective, MAX_STRING_LENGTH),
                                status: isStatus(args.status) ? args.status : undefined,
                            },
                            summary: clampString(args.summary, MAX_SANITIZED_LENGTH),
                            currentPlan: clampArray(args.currentPlan, MAX_ARRAY_ITEMS),
                            completedSteps: clampArray(args.completedSteps, MAX_ARRAY_ITEMS),
                            nextSteps: clampArray(args.nextSteps, MAX_ARRAY_ITEMS),
                            blockers: clampArray(args.blockers, MAX_ARRAY_ITEMS),
                            filesTouched: clampArray(args.filesTouched, MAX_ARRAY_ITEMS),
                            notes: clampArray(args.notes, MAX_ARRAY_ITEMS),
                        }, { origin: "tool", ...(snapshotName ? { snapshotName } : {}) });
                        // An explicit save is the primary path: restart the periodic counter.
                        if (store)
                            store.setRuntime(ref.sessionID, ref.projectID, { messagesSinceSave: 0 });
                        return json(outcome.data);
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_load",
                description: "Load this session's full current checkpoint state.",
                input: objectSchema({}),
                async execute(_input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const stored = requirement().load(ref);
                        return json(stored ? stored.data : { exists: false });
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_status",
                description: "Quick status summary for this session: whether a checkpoint exists, when it was updated, its status, step counts and blocker count.",
                input: objectSchema({}),
                async execute(_input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        return json(requirement().status(ref));
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_clear",
                description: "Delete this session's checkpoint state, its snapshot history and its generated handoff file. Affects only the calling session; other sessions in the same project are untouched.",
                input: objectSchema({}),
                async execute(_input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const result = requirement().clear(ref);
                        return json({
                            cleared: true,
                            sessionID: ref.sessionID,
                            checkpoints: result.checkpoints,
                            snapshots: result.snapshots,
                            handoffRemoved: result.handoffRemoved,
                        });
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_list",
                description: "List this session's snapshots newest first, with name, savedAt, title and status, plus creation time and kind. Use checkpoint_load_snapshot to inspect one, checkpoint_restore_snapshot to restore it.",
                input: objectSchema({}),
                async execute(_input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const snapshots = requirement().listSnapshots(ref);
                        return json({
                            sessionID: ref.sessionID,
                            count: snapshots.length,
                            snapshots: snapshots.map((snapshot, index) => ({
                                index,
                                name: snapshot.name,
                                kind: snapshot.kind,
                                savedAt: snapshot.savedAt,
                                restoredAt: snapshot.restoredAt,
                                title: snapshot.data.task?.title ?? null,
                                status: snapshot.data.task?.status ?? null,
                            })),
                        });
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_load_snapshot",
                description: "Read one named snapshot from this session's history. Read-only: it does not change the live checkpoint. Use checkpoint_restore_snapshot to promote it.",
                input: objectSchema({ name: { type: "string" } }, ["name"]),
                async execute(input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const svc = requirement();
                        const name = String(input.name ?? "");
                        const snapshot = svc.loadSnapshot(ref, name);
                        if (!snapshot) {
                            return json({
                                error: "Snapshot not found",
                                name,
                                available: svc.listSnapshots(ref).map((entry) => entry.name),
                            });
                        }
                        return json(snapshot.data);
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_restore_snapshot",
                description: "Promote a named snapshot to this session's live state. The current live state is captured first as a 'pre-restore-<timestamp>' snapshot, which pruning always retains, so the restore can be undone by restoring that snapshot.",
                input: objectSchema({ name: { type: "string" } }, ["name"]),
                async execute(input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const name = String(input.name ?? "");
                        return json(requirement().restoreSnapshot(ref, name));
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
            {
                name: "checkpoint_migrate",
                description: "Report pre-SQLite (JSON) checkpoint data found for this project, and optionally adopt it into the calling session. Adoption is opt-in because legacy project-level state has no recorded session: without adopt=true it is only reported.",
                input: objectSchema({
                    adopt: { type: "boolean", description: "Copy the legacy live state into this session as an adopted snapshot" },
                }),
                async execute(input, context) {
                    try {
                        const ref = await resolver.resolve(sessionIDOf(context));
                        const svc = requirement();
                        ensureLegacyImported(ref.projectID, ref.projectDirectory);
                        const adopt = input.adopt === true;
                        return json(svc.adoptLegacy(ref, adopt));
                    }
                    catch (error) {
                        return json({ ok: false, error: messageOf(error) });
                    }
                },
            },
        ];
        await ctx.tool.transform((editor) => {
            for (const definition of tools)
                editor.add(definition);
        });
        // ------------------------------------------------------------------ hooks
        // Trigger B: persist every Nth admitted user prompt, per session.
        await ctx.session.hook("prompt", async (event) => {
            try {
                const svc = service;
                if (!svc || svc.autosaveEvery <= 0)
                    return;
                const ref = await resolver.resolve(String(event.sessionID));
                ensureLegacyImported(ref.projectID, ref.projectDirectory);
                svc.tickPrompt(ref);
            }
            catch (error) {
                logger.warn("Periodic checkpoint trigger failed", { error: messageOf(error) });
            }
        });
        // Trigger A: compaction. Persist state and make it visible to the summarizer.
        await ctx.session.hook("compaction", async (event) => {
            try {
                const svc = service;
                if (!svc)
                    return;
                const ref = await resolver.resolve(String(event.sessionID));
                const outcome = svc.handleCompaction(ref, { synthesize: true });
                if (outcome.injection) {
                    event.system.push({ type: "text", text: outcome.injection });
                }
            }
            catch (error) {
                logger.error("Compaction checkpoint hook failed", { error: messageOf(error) });
            }
        });
        // ------------------------------------------------------- events / cleanup
        const controller = new AbortController();
        void (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                    const type = event.type;
                    if (type !== "session.compacted")
                        continue;
                    const sessionID = extractSessionID(event);
                    if (!sessionID)
                        continue;
                    const svc = service;
                    if (!svc)
                        continue;
                    const ref = await resolver.resolve(sessionID);
                    // Durability net: same session-scoped, change-detecting write path.
                    svc.handleCompaction(ref, { synthesize: true });
                }
            }
            catch (error) {
                if (!controller.signal.aborted) {
                    logger.warn("Event subscription ended", { error: messageOf(error) });
                }
            }
        })();
        return () => {
            controller.abort();
            try {
                store?.close();
            }
            catch (error) {
                logger.warn("Failed to close checkpoint database", { error: messageOf(error) });
            }
        };
    },
});
function sessionIDOf(context) {
    const value = context.sessionID;
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("Tool invoked without a session id; refusing to touch checkpoint state");
    }
    return value;
}
