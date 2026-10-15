/**
 * Pure helpers: clamping, sanitization, payload normalization, merge semantics,
 * and stable fingerprints. No SDK and no I/O.
 */
import { createHash } from "node:crypto";
import { PAYLOAD_SCHEMA_VERSION, STATUSES, } from "./types.js";
export const MAX_STRING_LENGTH = 50_000;
export const MAX_ARRAY_ITEMS = 1_000;
export const MAX_SANITIZED_LENGTH = 10_000;
export const MAX_ARRAY_ITEM_LENGTH = 2_000;
export function nowIso() {
    return new Date().toISOString();
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function clampString(value, max) {
    if (typeof value !== "string")
        return undefined;
    return value.length > max ? value.slice(0, max) : value;
}
export function clampArray(value, max, maxItem = MAX_ARRAY_ITEM_LENGTH) {
    if (!Array.isArray(value))
        return undefined;
    const out = [];
    for (const item of value.slice(0, max)) {
        if (typeof item === "string")
            out.push(item.length > maxItem ? item.slice(0, maxItem) : item);
        else if (item === null || item === undefined)
            continue;
        else
            out.push(String(item).slice(0, maxItem));
    }
    return out;
}
export function clampInt(value, min, max, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
export function isStatus(value) {
    return typeof value === "string" && STATUSES.includes(value);
}
/** Escape the characters that could break out of Markdown/HTML contexts. */
export function sanitizeForMarkdown(value) {
    if (typeof value !== "string")
        return "";
    return value.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function sanitizeArrayForMarkdown(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => sanitizeForMarkdown(item));
}
/**
 * Coerce arbitrary parsed JSON (historical payloads, foreign input, corrupted
 * files) into a well-formed CheckpointData. Never throws.
 */
export function normalizeData(raw) {
    const source = isRecord(raw) ? raw : {};
    const task = isRecord(source.task) ? source.task : {};
    // Historical/flat shapes may have carried the task fields at the top level.
    const title = task.title ?? source.title;
    const objective = task.objective ?? source.objective;
    const status = task.status ?? source.status;
    return {
        version: PAYLOAD_SCHEMA_VERSION,
        updatedAt: clampString(source.updatedAt, 64) ?? nowIso(),
        task: {
            title: clampString(title, MAX_STRING_LENGTH),
            objective: clampString(objective, MAX_STRING_LENGTH),
            status: isStatus(status) ? status : undefined,
        },
        summary: clampString(source.summary, MAX_SANITIZED_LENGTH),
        currentPlan: clampArray(source.currentPlan, MAX_ARRAY_ITEMS) ?? [],
        completedSteps: clampArray(source.completedSteps, MAX_ARRAY_ITEMS) ?? [],
        nextSteps: clampArray(source.nextSteps, MAX_ARRAY_ITEMS) ?? [],
        blockers: clampArray(source.blockers, MAX_ARRAY_ITEMS) ?? [],
        filesTouched: clampArray(source.filesTouched, MAX_ARRAY_ITEMS) ?? [],
        notes: clampArray(source.notes, MAX_ARRAY_ITEMS) ?? [],
    };
}
/**
 * Field-wise merge used by every save path. Absent incoming fields never clobber
 * stored data; `null`/`undefined` both mean "leave unchanged".
 */
export function deepMerge(existing, incoming) {
    const prev = existing ?? null;
    return {
        version: PAYLOAD_SCHEMA_VERSION,
        updatedAt: nowIso(),
        task: {
            title: incoming?.task?.title ?? prev?.task?.title,
            objective: incoming?.task?.objective ?? prev?.task?.objective,
            status: incoming?.task?.status ?? prev?.task?.status ?? "in_progress",
        },
        summary: incoming?.summary ?? prev?.summary,
        currentPlan: incoming?.currentPlan ?? prev?.currentPlan ?? [],
        completedSteps: incoming?.completedSteps ?? prev?.completedSteps ?? [],
        nextSteps: incoming?.nextSteps ?? prev?.nextSteps ?? [],
        blockers: incoming?.blockers ?? prev?.blockers ?? [],
        filesTouched: incoming?.filesTouched ?? prev?.filesTouched ?? [],
        notes: incoming?.notes ?? prev?.notes ?? [],
    };
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (isRecord(value)) {
        const out = {};
        for (const key of Object.keys(value).sort())
            out[key] = canonical(value[key]);
        return out;
    }
    return value;
}
/**
 * Stable fingerprint of the *content* of a checkpoint, ignoring `updatedAt`.
 * Used to detect real progress so that periodic re-saves are not mistaken for
 * new work and so injected context is not repeated.
 */
export function contentFingerprint(data) {
    if (!data)
        return "";
    const rest = { ...data };
    delete rest.updatedAt;
    return JSON.stringify(canonical(rest));
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
let autoSnapshotSequence = 0;
/**
 * Collision-free automatic snapshot name.
 *
 * A bare millisecond timestamp is not unique: two writers on the same session
 * within the same millisecond would collide on the (session, name) constraint
 * and silently replace each other's history. The process id and a counter keep
 * names unique without giving up time-ordered readability.
 */
export function autoSnapshotName(at = new Date()) {
    autoSnapshotSequence = (autoSnapshotSequence + 1) % 1_679_616;
    return `auto-${at.getTime()}-${process.pid.toString(36)}${autoSnapshotSequence.toString(36)}`;
}
/** Strip characters that are unsafe in a path segment (session ids are used in filenames). */
export function safePathSegment(value) {
    const cleaned = String(value)
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/^\.+/, "_");
    return (cleaned.length > 0 ? cleaned : "_").slice(0, 120);
}
