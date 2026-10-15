# Compatibility

## Matrix

| | 1.0.1 (published) | 2.0.0-dev (this branch) |
|---|---|---|
| OpenCode V1 | yes | **no** |
| OpenCode V2 | no | yes (verified against `opencode` 2.0.21) |
| Plugin SDK | `@opencode-ai/plugin` ^1.14.40 | `@opencode/plugin` 2.0.21 |
| Config key | `plugin` | `plugins` |
| Storage | `.opencode/state/*.json` (project-level) | `checkpoints.db` (SQLite, session-scoped) |
| Session isolation | no — one shared checkpoint per project | yes |
| Handoff file | `.opencode/state/handoff.md` | `.opencode/state/handoff-<sessionId>.md` |
| Tools | 7 | 7 preserved + `checkpoint_migrate` |
| Test suite | duplicated logic, no production imports | drives `dist/` and the real V2 entry |
| Node runtime for tests | 18 / 20 / 22 | 22 / 24 |

## V1 status: intentionally dropped

The 2.0 line does not support the V1 plugin API. This is a deliberate decision,
not an omission:

* **V1 has no per-session tool context.** V1 tool execution does not receive the
  calling session, so session isolation — the reason this release exists — cannot
  be implemented correctly on V1. Any V1 build would keep the shared
  project-level checkpoint and its collision risk.
* **The dual-export escape hatch does not help here.** A package can expose both
  `setup()` (V2) and `server()` (V1) from one default export, but the two APIs do
  not share session identity, so the shared export would only paper over the
  isolation gap with two divergent implementations.
* **The V1 line is still available.** `@gitdamnit/checkpoint-orchestrator@1.0.1`
  remains published and installable. Users who cannot upgrade OpenCode should
  stay on it.

If V1 support is required later, the correct shape is a separate entry point and
a separate package version rather than one hybrid export, and the V1 side would
have to keep the project-level storage model (and document that it is not
session-isolated).

## Runtime compatibility

| Runtime | Supported | Notes |
|---|---|---|
| OpenCode's bundled Bun | ≥ 1.4 | `node:sqlite` is available from Bun 1.4; verified on 1.4.2 |
| Node.js | ≥ 22.5 | `node:sqlite` is built in. On Node 22.5–22.12 it needs `--experimental-sqlite`; verified without a flag on 22.23.2 |
| Bun (standalone) | ≥ 1.4 | verified on 1.3.14 / 1.4.2 for `bun:sqlite`; `node:sqlite` requires ≥ 1.4 |
| Deno | no | `node:sqlite` is not provided |

## SDK version pinning

`@opencode/plugin` is pinned to `2.0.21`, the version this branch was verified
against (`opencode` 2.0.21 was the installed runtime). The package's own releases
track OpenCode releases, and later minors may add APIs; upgrading the pin should
be paired with re-running `npm run test:opencode` in a real runtime. The
compatibility surface actually used here is small and stable: `Plugin.define`,
`ctx.location`, `ctx.options`, `ctx.session.get/hook`, `ctx.tool.transform`,
`ctx.event.subscribe`, and `ctx.app.version`.
