# Architecture

## Layers

```
plugins/checkpoint-orchestrator.ts   V2 entry: Plugin.define({ id, setup })
  ├─ resolves the calling session and project   (SessionResolver)
  ├─ registers 8 tools                          (ctx.tool.transform)
  ├─ registers 2 session hooks                  (prompt, compaction)
  ├─ subscribes to the event stream             (session.compacted)
  └─ delegates every decision to ↓
plugins/core/service.ts              Session-scoped policy
  ├─ save / restore / clear / status / list
  ├─ snapshot policy and undo guarantees
  ├─ legacy import and explicit adoption
  └─ uses ↓
plugins/core/store.ts                SQLite storage (node:sqlite)
plugins/core/{schema,legacy,handoff,paths,types,util}.ts
```

`core/*` imports no OpenCode SDK code. That is deliberate: the test suite
imports the compiled `dist/core/*.js` directly, so the tests exercise production
code rather than a copy of it. The entry file is thin wiring, and it is covered
by `tests/plugin.test.js`, which drives the real default export through a fake
V2 context.

## Driver decision

**`node:sqlite`.** It is the only candidate that is built into both runtimes this
project has to run in, so it adds no dependency, no native build step, and no ABI
to match.

Evidence, gathered by running the same conformance probe in both runtimes
(`tests/driver-conformance.cjs`, results in the table below):

| Capability | Node 22.23.2 (SQLite 3.51.3) | OpenCode runtime: Bun 1.4.2 (SQLite 3.53.2) |
|---|---|---|
| `node:sqlite` available | yes | yes |
| `bun:sqlite` | n/a | yes |
| `better-sqlite3` | loads | loads (Bun compatibility layer) |
| WAL, `synchronous=NORMAL`, `busy_timeout` | yes | yes |
| Foreign keys enforced, cascade delete | yes | yes |
| Transactions, savepoints, rollback | yes | yes |
| `integrity_check`, `foreign_key_check` | yes | yes |
| Concurrent handles / writers | yes | yes |
| JSON functions (`json_extract`) | yes | yes |

Why not `better-sqlite3`: it is a V8 native addon. It only loads in the OpenCode
runtime because Bun ships a compatibility implementation, not the real addon, so
the implementation under test would differ between CI (Node) and production
(Bun). It also reintroduces exactly the install-time failure mode this project
has hit before: a platform-specific binary that must match the runtime ABI when a
user installs the package.

Why not `bun:sqlite`: it is Bun-only, so the whole test suite would have to run
under Bun, and the plugin would stop working if a plugin host ever used Node.

`node:sqlite` is marked experimental in Node (a warning is printed). It has been
stable in practice across the API surface used here, and the alternatives carry
larger risks. The driver is isolated behind `CheckpointStore`, so replacing it is
a single-file change.

## Storage layout

```sql
projects(id PK, directory UNIQUE, canonical, created_at, updated_at)
sessions(id PK, project_id → projects, parent_id, title, created_at, updated_at)
checkpoints(session_id PK → sessions, project_id → projects, title, objective, status,
            summary, current_plan, completed_steps, next_steps, blockers, files_touched,
            notes, schema_version, synthesized, created_at, updated_at)
snapshots(id PK, session_id → sessions, project_id → projects, name, kind, captured_at,
          payload, schema_version, restored_at, UNIQUE(session_id, name))
session_runtime(session_id PK → sessions, messages_since_save, last_injected_hash,
                last_autosave_at, updated_at)
migrations(id PK, project_id, applied_at, details)
```

* Arrays are stored as JSON text: they are opaque task state, and normalizing
  them into tables would add joins without adding integrity.
* Snapshot `payload` is a frozen JSON copy of the checkpoint at capture time.
* `synthesized` distinguishes real saved state from a placeholder created when
  compaction happens with nothing saved.
* `checkpoints` and `snapshots` carry a composite foreign key to
  `sessions(id, project_id)`, so a row cannot claim a project its session does not
  belong to.
* `PRAGMA user_version` tracks the schema. Migrations are forward-only, run in a
  transaction, and an unknown *future* version is refused rather than used.
  Migration 2 replaces `UNIQUE(projects.directory)` with a plain index: project
  identity is the id, and a host may report two ids for one canonical directory
  (a checkout plus a worktree of it, or a moved repository).

## Invariants

1. **Session isolation.** `session_id` is the scoping key for every read and
   write. A missing or malformed id throws (`requireId`) instead of binding
   `null` and silently matching nothing.
2. **Atomic read-merge-write.** `save()` performs its read, merge and write
   inside one `BEGIN IMMEDIATE` transaction, so two writers on the same session
   cannot lose each other's fields.
3. **No phantom progress.** An unchanged payload is not written, does not move
   `updatedAt`, and does not create a snapshot.
4. **Undo is never pruned away.** Pruning keeps the newest `historyLimit`
   snapshots *and* the newest `pre-restore` snapshot.
5. **Collision-free auto snapshot names.** `auto-<ms>-<pid><seq>`. A bare
   timestamp is not unique: two writers in the same millisecond would collide on
   `UNIQUE(session_id, name)` and silently replace history.
6. **Derived artifacts only.** `handoff.md` is written from committed rows and is
   never read back as authoritative state. Its path is
   `checkpoint-orchestrator/handoff-<sanitized session id>.md`, so sessions cannot collide or escape the
   state directory.
7. **Legacy import is additive and gated.** Originals are copied (never deleted),
   the import is transactional and idempotent via a ledger row, and legacy state
   lands in a `legacy::<projectID>` namespace rather than in a live session. A
   payload that does not match this plugin's schema is reported and skipped, so a
   same-named file owned by another tool can never be consumed.
8. **Namespaced persistence.** Everything this plugin writes lives under its own
   namespace — the database directory, and
   `.opencode/state/checkpoint-orchestrator/` for derived exports and migration
   backups — so co-installed plugins sharing `.opencode/` cannot collide with it.

## Concurrency and durability

* WAL journalling keeps readers from blocking the writer, and
  `synchronous = NORMAL` avoids an `fsync` per commit. On a slow filesystem this
  matters: measured here, one `fsync` costs roughly 0.7–1.5 s, so `FULL` would
  make every save visibly slow.
* `busy_timeout = 5000` plus a small retry loop around `BEGIN IMMEDIATE` handles
  a competing writer or checkpoint. The first schema creation is itself one
  `BEGIN IMMEDIATE` transaction that re-reads `PRAGMA user_version` after taking
  the lock, because several processes can open a brand-new database at the same
  instant and all observe version 0 before any of them commits.
* Crash safety is not assumed: `tests/store.test.js` `SIGKILL`s a child process
  in the middle of an open transaction and asserts that the committed write
  survived, the uncommitted one did not, and `integrity_check` still reports
  `ok`. Multi-process access is exercised with four concurrent writer processes,
  six concurrent first-opens of one new database, and six concurrent legacy
  imports.

## Measured cost (this machine, ext4)

| Operation | Time |
|---|---|
| Open a brand-new database (schema + first WAL setup) | ~2.7 s, once per database |
| Re-open an existing database | ~0 ms |
| One full save (transaction + checkpoint upsert + snapshot + prune) | ~80 ms |
| 100 checkpoint loads | ~5 ms |
| Close (WAL checkpoint) | ~1 s |
