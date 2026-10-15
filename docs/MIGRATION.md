# Migration

Two things change in 2.0.0: the plugin API (V1 → V2) and the storage contract
(project-level JSON → session-scoped SQLite).

## 1. OpenCode configuration

The key is `plugins` in V2, and a package plus options is now an object.

```jsonc
// V1 — no longer read by this package
{
  "plugin": ["@gitdamnit/checkpoint-orchestrator"]
}

// V2
{
  "plugins": ["@gitdamnit/checkpoint-orchestrator"]
}
```

```jsonc
// V2 with options
{
  "plugins": [
    { "package": "@gitdamnit/checkpoint-orchestrator", "options": { "historyLimit": 20 } }
  ]
}
```

V1 plugin *implementations* do not run in V2. If you are porting your own plugin,
`Plugin.define({ id, setup })` replaces the exported function, tools move to
`ctx.tool.transform`, and string-keyed hooks move onto their domain
(`ctx.session.hook("prompt" | "compaction", …)`, `ctx.event.subscribe()`). See
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for this package's V1 status.

## 2. What happens to existing JSON checkpoints

Legacy files live at `.opencode/state/checkpoint.json` and
`.opencode/state/checkpoint-history.json` in each project.

On first load, for each project the plugin:

1. Detects the legacy files and validates them.
2. Copies them to `.opencode/state/<name>.legacy-backup-<timestamp>`. **Originals
   are never modified or deleted.**
3. Imports everything inside a single transaction into a clearly named legacy
   namespace: a project row for the directory, and a session row whose id is
   `legacy::<projectID>` with the title
   "Legacy project-level checkpoint (imported)".
4. Writes a ledger row (`legacy-json:<projectID>`) so the import cannot run twice
   on repeated startup.
5. If any step fails, the transaction rolls back and the ledger row is not
   written, so the import can be retried on the next start.

Legacy snapshot names and timestamps are preserved. If two legacy snapshots share
a name, later ones are suffixed (`name#2`) instead of overwriting each other. The
import honours your configured `historyLimit`.

Set `legacyImport: "off"` to skip the automatic import entirely.

### Why it is not attached to your session automatically

A project-level JSON checkpoint has no recorded session id. Copying it into
"whatever session happens to be running" is exactly the collision this release
removes, so the import never guesses.

## 3. Resuming work that was in a legacy checkpoint

Legacy state is imported, not adopted. Adoption is explicit and per session:

```text
checkpoint_migrate                       # report: is there legacy data? has it been imported?
checkpoint_migrate { "adopt": true }     # copy it into THIS session
```

Adoption creates a snapshot named `adopted-legacy-<timestamp>` and records the
adoption in the ledger. The legacy namespace is left intact, so nothing is
consumed and the operation is repeatable in another session.

## 4. Going back to 1.x

Legacy files are untouched, so reverting is a configuration change:

1. `plugins` → `plugin` in `opencode.json(c)`.
2. Install `@gitdamnit/checkpoint-orchestrator@1.0.1`.
3. Restart OpenCode. The 1.x plugin reads the original
   `.opencode/state/checkpoint.json` again.

Any work saved *after* upgrading exists only in the SQLite database. Use
`checkpoint_load` to read it and `checkpoint_save` in the 1.x line to write it
back into `.opencode/state/`, or keep the database and upgrade again later. The
database is never deleted by an upgrade.

## 5. Permissions and locations to expect

* `~/.local/share/opencode/checkpoint-orchestrator/checkpoints.db` (Linux),
  directory `0700`, file `0600`.
* `.opencode/state/handoff-<sessionId>.md` per session, regenerable at any time.

If you want the database somewhere else, set `databasePath` or
`CHECKPOINT_ORCHESTRATOR_DB`.
