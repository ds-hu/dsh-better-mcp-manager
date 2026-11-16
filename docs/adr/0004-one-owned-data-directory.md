# 4. All state lives in one plugin-owned directory

Date: 2026-11-16
Status: accepted

## Context

The plugin has to store server records, including OAuth secrets and custom header values. DSH
offers a `storages` service, the profile's configuration files, and plain files. The user's
requirement is a **clean uninstall**: removing the plugin must leave no residue in the profile or
in the DSH home that the user did not choose to keep.

- A `storages`-backed store is the idiomatic choice, but its data lives in DSH-owned state and
  survives the plugin; uninstalling does not delete it.
- Profile configuration (or preset YAML) would mix plugin state into files the user owns and the
  next plugin must not break.
- Plain JSON in a directory named after the plugin is boring, greppable, and deletable.

## Decision

The plugin owns exactly one directory:

```
$DSH_HOME/better-mcp-manager/     mode 0700
├── servers.json                  mode 0600, atomic replace
└── icons/                        mode 0700, one uploaded image per server, files 0600
```

`lib/store.js` ensures the directory exists (mode `0700`) when the plugin mounts; `servers.json`
appears on the first write and `icons/` on the first upload. The store is written with a
temporary file and `rename` in the same directory, and read with corrupt-file quarantine. Uploaded
icons are written by `lib/icons.js` through the same temporary-file/`rename` pattern into `icons/`.
No other path is ever written: not the profile's `cordis.patch.yml`, not preset files, not the
sessions directory. `DSH_MCP_MANAGER_DATA_DIR` can point the directory elsewhere (used by tests and
scratch instances); the Host and the CLI resolve it the same way.

`bin/mcp-manager.mjs clean --yes` deletes that one directory and nothing else. Its guard is a
resolved path whose final segment is `better-mcp-manager`, or exactly the explicit
`DSH_MCP_MANAGER_DATA_DIR` value; it refuses anything else. The bundle is removed with
`dsh plugin --profile <p> remove @ds-hu/dsh-better-mcp-manager` (or the Plugins page), which removes
the code, the row and the route.

## Consequences

- **Uninstall is two explicit steps with nothing hidden**: remove the bundle, then delete the
  directory (or keep it and reinstall later — the records and uploaded icons are still valid).
- Mounting the plugin creates its own data directory (mode `0700`) if it does not exist yet, but
  nothing in the profile; a profile that installs and never configures a server gets at most that
  empty directory.
- Secrets in headers and OAuth settings are stored in plaintext inside `servers.json`, protected by
  filesystem mode `0600` on the file (and `0700` on the directory); uploaded icons are separate
  `0600` image files inside `icons/`. This is stated in the README: the store must not be committed,
  copied to a shared machine, or included in a bug report without redaction.
- Two DSH processes pointed at the same `$DSH_HOME` would race on the file. The profile is
  per-user and normally one process, so the store does not add a lock file — a lock would itself
  be residue.
- The CLI's `clean` is the only code that deletes data; it refuses a resolved path that is not a
  `better-mcp-manager` directory (and is not the explicit override), so a mistyped `DSH_HOME`
  cannot turn it into a broad delete.
