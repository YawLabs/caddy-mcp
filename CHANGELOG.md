# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`@modelcontextprotocol/sdk` moves from `^1.29.0` to `^1.30.0`, and
  `npm audit` is clean again (11 findings, 5 high, before).** The SDK is a runtime
  dependency, so the new floor reaches everyone who installs this package; the
  `overrides` floors, each raised to its advisories' first patched version,
  shape only this repo's own tree. The SDK's transitive `fast-uri` 3.1.2 →
  3.1.7, `hono` 4.12.26 → 4.13.7, `@hono/node-server` 1.19.13 → 1.19.17,
  `ip-address` 10.2.0 → 10.7.0 (with `express-rate-limit` 8.3.2 → 8.7.0), `qs`
  6.15.2 → 6.16.0 and `body-parser` 2.2.2 → 2.3.0 all clear their advisories,
  as do the dev-only `vitest` 4.1.10 → 4.1.11, `postcss` 8.5.10 → 8.5.28 and
  `nanoid` 3.3.11 → 3.3.19. The published `dist/` bundles none of these —
  tsup leaves the SDK external — so no copy of `fast-uri` 3.1.2 shipped inside
  this package; installs resolve the SDK's tree themselves.

## [2.5.1] — 2026-09-14

### Fixed
- **A tool call right after a config change no longer fails with "Cannot
  connect to Caddy admin API … is Caddy running?" while Caddy is fine.** Caddy
  restarts its admin endpoint after every config load and closes the pooled
  keep-alive connections; the next request could be written to a socket Caddy
  had just closed. On Caddy 2.11.4 that hit 10 of 25 runs of the live suite
  (157 failed requests in 15 runs, every one on a reused socket). After a
  successful config change the client now waits — event-driven, capped at
  250 ms — until no pooled socket to the admin origin remains, so the next
  request opens a fresh connection; 50 of 50 runs pass with the change. A
  refused connection is now retried for every method, including `POST` and
  array-index `PUT`, because a refused connect proves nothing was sent; a reset
  is still never replayed for a `POST`, which appends and would duplicate a
  route. `Connection: close` on every request was measured and rejected: on
  Windows it can leave Caddy's admin endpoint permanently refusing connections
  (2 wedges in about 1,400 restarts, none with keep-alive).

### Changed
- npm and MCP Registry listing metadata: bugs URL, core keywords, and
  server.json title/repository/websiteUrl
- `release.sh` writes a `## [x.y.z]` changelog entry for every release —
  promoting `[Unreleased]` when it has content, otherwise generating one from
  the commit subjects since the previous tag — and takes the GitHub release
  notes from that entry instead of from `git log` subjects. Before this, the
  script never touched this file: promotion was a separate hand-written
  commit when someone remembered, and otherwise the version got no entry at
  all (2.5.0 below is backfilled, and 2.4.1 plus the twelve older versions
  that had none have since been backfilled too), and every GitHub release page
  showed raw commit subjects even when an entry existed. Keep-a-Changelog compare links are
  moved along too, should this file ever gain them.

## [2.5.0] — 2026-09-13

Release tooling and documentation only; no change to the published package's
behavior.

### Changed
- `release.sh` waits for npm to actually serve a freshly published version
  before the MCP Registry step. `npm publish` returns as soon as the registry
  accepts the tarball, but the version is not yet readable from npm's
  CDN-backed read path, and the MCP Registry validates a submission by reading
  it — so a registry publish straight after `npm publish` could fail with
  `version 'x.y.z' was not found (status: 404)` and the release needed a second
  run (ssh-mcp and aws-mcp both hit this). The wait polls the exact URL the
  registry's validator fetches, `registry.npmjs.org/@yawlabs%2Fcaddy-mcp/<version>`,
  with `curl` rather than `npm view`, whose 5-minute metadata cache can keep
  reporting the pre-publish answer, and it warns rather than fails at its 300s
  cap so `mcp-publisher` still gets to report its own precise error.
  `SKIP_NPM_WAIT=1` bypasses the wait and `NPM_WAIT_TIMEOUT_S` retunes it (#51).
- README: the X follow badge moved from the top of the page to the bottom, so
  the description leads on npm and GitHub (#52).

## [2.4.4] — 2026-09-13

### Fixed
- **The launcher always uses the newest oam, and the minimum is now the latest
  release, 0.15.2.** It used to take the FIRST oam binary it found and only then
  check its version, so a stale copy in an earlier location hid a current one:
  with oam 0.9.0 in `~/.oam/bin` and 0.15.2 on `PATH`, it ran 0.9.0. Every oam
  binary it can see is now asked for its version, and the newest at or above
  0.15.2 wins; on a tie the installed copy still wins.
- **An oam host older than the floor no longer serves the server itself.** When a
  client ran `oam run bin/caddy-mcp.mjs` with an old oam and no usable one was
  found, the server ran on that old oam. When one WAS found, the handoff inherited
  stdio, which an oam before 0.9.0 does not honor, so the MCP handshake never
  answered. An old host now hands off with piped stdio to the newest usable oam,
  or to Node on `PATH`, or exits with an error when there is neither.
  `CADDY_MCP_SANDBOX=1` on a supported oam host still spawns a fresh oam for
  `--permission`, now with piped stdio too; if none is usable under `auto` it
  still serves in the host process without the sandbox, as before.
- **A bad `OAM_BIN` is reported instead of ending discovery.** A path that does
  not exist, an oam below the floor, or a binary that will not run is named on
  stderr, and discovery carries on instead of dropping straight to Node.
- **`CADDY_MCP_RUNTIME=node` now always means Node.** Launched under `oam run`, it
  hands off to Node on `PATH` rather than staying on oam.
- Each `oam --version` probe is bounded at 5s, so a wedged binary on `PATH`
  cannot hang the launch. A spawn that fails under `auto` now says so on stderr
  before falling back.

## [2.4.3] — 2026-09-13

No functional changes. Republishes 2.4.2 under a new version.

## [2.4.2] — 2026-09-12

### Fixed
- **The launcher no longer boots a second oam when it is already running on one.**
  A host that resolves this package's `bin` and launches `oam run bin/caddy-mcp.mjs`
  — Yaw MCP does, and so does oam's sidecar regression matrix — got a nested oam:
  the launcher discovered and spawned one without asking what it was already
  running on, so one server cost two runtime boots (measured on Windows as
  `oam.exe` → `oam.exe` + `conhost.exe`). When `process.versions.oam` clears the
  same 0.9.0 floor a discovered binary must, the server is now imported into the
  host process. A host oam below the floor keeps the discovery path, and so does
  `CADDY_MCP_SANDBOX=1`, because `--permission` only applies to a fresh oam. That
  is a request for a spawn, not a guarantee: if no oam can be launched,
  `CADDY_MCP_RUNTIME=auto` still falls back in-process without `--permission`, as
  it always has — set `CADDY_MCP_RUNTIME=oam` alongside the sandbox to make that
  a hard failure instead.

## [2.4.1] — 2026-09-11

Repository tooling, npm listing metadata and documentation only; no change to
the server's behavior.

### Changed
- **`npm run lint` is a trustworthy gate on Windows ARM64.** Some
  `@biomejs/cli-win32-arm64` builds crash on every check-shaped run — measured
  on a win32-arm64 host, 2.5.4 exits 139 (while answering `--version` fine)
  where 2.4.16 and 2.5.13 run correctly — and this repo has no CI to catch what
  a crashed local lint let through. `lint` and `lint:fix` now route through
  `scripts/lint.mjs`: when the host's native biome binary is unusable it
  provisions the x64 build of the same version into a gitignored cache and
  runs that under emulation, otherwise it is a passthrough, and the exit code
  is biome's own. The version is read from `package-lock.json` (falling back
  to the installed package), not from `biome.json`'s `$schema` — that pins
  what the config validates against, not what the repo installs, and in most
  sibling repos the lockfile is newer; on tailscale-mcp linting with the schema
  version turned a release-blocking crash into a false pass. `release.sh`'s
  `SKIP_LINT` comment no longer blames the npm wrapper or claims CI catches
  lint regressions: there is no CI, so the hatch means publishing unlinted
  (#45).
- **npm listing metadata.** The package description leads with the noun people
  search for and every claim in it is README-backed, the keyword list grew
  from 8 to 18 terms, and `homepage` points at the server's page on yaw.sh
  instead of the GitHub repo. Visible on npmjs.com from this version (#46).
- README: a "Follow on X" badge in the top badge row (#42).

## [2.4.0] — 2026-08-31

### Fixed
- **The first-run path works.** On an instance with no config, Caddy has no `apps`
  key, so config reads fail the path walk instead of returning empty:
  `caddy_list_servers` answered a fresh instance with
  `{"error":"invalid traversal path at: config/apps/http"}` — a Go internal error
  from the tool whose entire job is to say what exists. It now reports `No HTTP
  servers configured`, matching `caddy_status` on the same state, and
  `caddy_list_routes` returns the create-it recipe. A traversal failure is
  decisive — no parent chain means no server — so asserting non-existence is honest
  here, unlike the ambiguous null body, which keeps its both-causes wording.
- **The "server does not exist" advice now works if you follow it.** It said to
  create the server with `{ "listen": [":443"] }`, which omits two things the
  follower needs: `mode: "append"`, because the default `overwrite` is a PATCH that
  fails with `key does not exist`; and `"routes": []`, because a POST creates a
  missing `routes` key as an *object*, so the very next call died with
  `cannot unmarshal object into ... RouteList`. A live test now follows the advice
  verbatim and adds a route to what it produces.
- **`serverNotFoundError` was unreachable from all three of its call sites.**
  `isParentMissing` matched only `404` / `key does not exist`, but a POST under a
  missing server answers HTTP 500 `invalid traversal path` — a shape no mocked
  fixture had ever produced — so the raw Go error reached the caller instead of the
  recipe. Both markers are matched now.
- **`caddy_config_delete` no longer advertises itself as idempotent.** Its own
  documented example path ends in an array index, and Caddy re-packs the array
  after a delete, so a repeat removes a different route. `caddy_remove_route`
  already carried this correction for the byte-identical underlying request.
- **Config paths are percent-encoded per segment.** A `#` or `?` in a config key
  truncated the request URL, because both are URL syntax rather than path text:
  `caddy_config_delete { path: "apps/http/servers/prod#1" }` sent
  `/config/apps/http/servers/prod` and deleted the PARENT server, reporting HTTP
  200 success. Reproduced against Caddy 2.11.4 and fixed by encoding each segment
  (so `/` keeps its separator meaning) — the raw path deleted `prod`, the encoded
  path deletes exactly `prod#1`. Traversal rejection still runs on the decoded
  form, so a literal `..` is still refused and a supplied `%2e%2e` is escaped
  rather than decoded into one.
- **`caddy_list_routes` reported an unknown server as an empty one.** Caddy answers
  a server name it does not know with HTTP 200 and a body of literal `null`, not a
  404, so the failure guard never fired and the null collapsed into an empty
  config: a mistyped name rendered as `no routes configured` with no error flag,
  telling an operator a live-looking server was empty and inviting them to
  overwrite it. It now errors, naming both possible causes — an absent key and a
  key whose value is `null` are byte-identical on the wire, and both are reachable.
- **`caddy_remove_route` could delete a non-route object by `@id`.** `@id`s are
  config-global in Caddy, so a removal targeting an id shared by a TLS issuer or a
  server block deleted that object instead. It now reads the object first and
  refuses anything without a top-level `handle` array, matching the guard
  `caddy_reverse_proxy` already applied on the write path.
- **`https://` upstreams are no longer silently downgraded to plaintext.** The
  scheme was stripped, so `to: ["https://backend"]` dialed port 80 in the clear.
- **`caddy_tls` refuses to write ACME fields onto a non-ACME issuer.** A config
  whose first issuer is `internal` (Caddy's local CA — an ordinary setup) accepted
  `email`/`profile` keys it has no use for, and `set_acme_ca` would silently
  repoint that issuer's own `ca` field at an ACME directory URL.
- **`CADDY_MCP_SANDBOX=1` denied every request.** Three separate faults: the
  launcher's default endpoint did not match the one `src/api.ts` dials; the grant
  pinned a port, which the `fetch` permission check never matches; and
  `CADDY_MCP_SNAPSHOT_DIR` was absent from the environment allowlist, so snapshot
  persistence degraded to memory-only with no diagnostic. A unix-socket admin URL
  additionally produced a BARE `--allow-net`, granting the whole network for the
  most hardened admin configuration Caddy recommends; it now emits no net grant at
  all, which is what denies the category.
- **An empty `tls_connection_policies` array no longer reports `TLS: enabled`.** It
  configures nothing, so it now reads the same as an absent key.
- **Resource reads no longer render `Error: undefined`** when a failure carries no
  error text; they fall back to the status code the way tool results already did.

### Changed
- **`caddy_revert apply` says so when no roll-forward snapshot was captured.** If
  the pre-revert read fails — which happens for an ordinary reason, since Caddy
  restarts its admin listener on every `/load` — the revert still succeeds, but the
  config it replaced went unrecorded and the revert cannot itself be undone. That
  now appears in the result instead of a bare success message.
- **Corrected two MCP tool hints.** `caddy_config_by_id` declares
  `destructiveHint: true` (it has a `delete` action), and `caddy_remove_route`
  declares `idempotentHint: false` (true for `@id`, false for index removal, where
  Caddy re-packs the array so a repeated index removes a different route).
- **`caddy_reverse_proxy` rejects an empty `to` array and blank upstream entries**
  rather than writing a proxy with no upstreams or a `dial` of `""`.

### Added
- **Roughly 60 tests**, covering the fixes above plus the branches a coverage pass
  found unpinned: the `caddy_list_routes` formatter arms (a null matcher, a
  `dial`-less upstream, `file_server`, and the `rewrite`/`authentication`/`error`
  placeholders — all of which already handled these shapes correctly, but had no
  test saying so, and each sits one careless edit away from throwing on a config
  Caddy accepts), the launcher's version-gate and spawn-failure fallbacks, and the
  empty-body error branch in `src/api.ts`. Four run against a live Caddy, where the
  mocked suite cannot see what the admin API actually returns.
- **`esbuild` is declared in `devDependencies`.** `scripts/build-binary.mjs`
  imports it directly but it resolved only as a transitive install.

## [2.3.2] — 2026-08-23

### Changed
- **The launcher's shutdown grace window is 5 seconds, up from 2.** The timer only
  ever elapses when the child has NOT exited on its own, and what follows is a hard
  kill (`SIGKILL`, or `TerminateProcess` on Windows) of a server that may be
  mid-shutdown -- flushing a large config, finishing a TLS provision. Waiting too
  long costs a few extra seconds on an already-wedged child; waiting too little
  truncates a legitimate shutdown, which is the failure this timer exists to avoid
  causing. A graceful child is unaffected: it still exits on its own in
  milliseconds, well inside either window.

## [2.3.1] — 2026-08-23

### Added
- **Tests for `bin/caddy-mcp.mjs`**, the published entry point. It sat outside both
  existing gates -- `npm run lint` scopes to `src/`, and nothing exercised `bin/` --
  so the launcher rewrite landed with no automated coverage despite being the file
  every install runs. Covers runtime selection (`node` / `auto` fallback / explicit
  `oam` failing loudly), an MCP handshake through the launcher, the oam version
  floor, and the signal behavior: a graceful child runs its own shutdown, a wedged
  child is escalated rather than hung on, and repeat signals do not hard-kill a
  child that is already exiting.

  Signal cases are POSIX-gated -- Windows has no POSIX signals, which is why the
  launcher forwards nothing there. A stand-in `oam` supplied via `OAM_BIN` makes
  this testable without installing the runtime; it must answer `--version` with a
  version at or above the floor, because the launcher's probe is a synchronous
  `execFileSync` and an unparseable answer silently downgrades it to the Node path.

### Changed
- **The minimum oam version is now actually enforced.** `oamVersion()` and `atLeast()` were defined but never called, so `OAM_MIN` was dead code and any oam on the box was spawned regardless of version — including the pre-0.9.0 releases the floor exists to exclude, where `child_process.execFile` ran its arguments through a shell, `exec` accepted `timeout` and ignored it, and `stdio: 'inherit'` behaved as `'pipe'`. This launcher shells out on its main paths, so those were reachable bugs. An oam below the floor is now refused under `CADDY_MCP_RUNTIME=oam` and bypassed for Node under `auto`, in both cases saying which version it found.

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which
  had eaten `%LOCALAPPDATA%\oam\bin` down to `%LOCALAPPDATA%oam<BS>in` in the rendered
  source. (An earlier version of this entry said the byte made git treat the file as
  binary; that is wrong -- git's binary heuristic keys on a NUL byte, and the file has
  none. The diff was always reviewable as text.)
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

## [2.3.0] — 2026-08-23

### Added

- **Unix socket admin endpoints.** `CADDY_ADMIN_URL` now accepts `unix:///var/run/caddy-admin.sock`
  (and Caddy's own `unix//var/run/caddy-admin.sock` spelling), routing requests through
  `node:http` with `socketPath` instead of the global `fetch`, which cannot dial a unix
  socket at all. Moving the admin API onto a unix socket is Caddy's own hardening
  recommendation, and those instances were previously unreachable. The unix path sends
  **no** `Origin` header — the exact opposite of the TCP path: Caddy builds no default
  origin allowlist for a unix/fd admin listener and only runs its origin check when
  `Origin` or `Sec-Fetch-Mode` is present, so sending one opts into a check against an
  empty allowlist and always 403s.
- **`caddy_tls` action `set_acme_profile`.** Sets the ACME issuer's `profile` field
  (Caddy 2.10+). Let's Encrypt uses it to issue 6-day short-lived certificates under
  the `shortlived` profile. Valid names are defined by the CA, so the value passes
  through unvalidated.
- **`caddy_tls` action `ech_status`.** Reads the Encrypted ClientHello config at
  `apps/tls/ech` (Caddy 2.10+). Read-only: enabling ECH needs a DNS provider credential
  and a publication policy, which belong in a full config applied via `caddy_load`.
  ECH is rarely enabled, so an absent config reports "not configured" as the answer
  rather than surfacing Caddy's raw 404 as a read error.
- **Optional snapshot persistence.** `CADDY_MCP_SNAPSHOT_DIR` writes each `caddy_revert`
  snapshot to disk and rehydrates the ring on first access, so a rollback target survives
  a server restart. Unset keeps the previous memory-only behavior. Opt-in because
  snapshots are full Caddy configs and can carry secrets. Corrupt files are skipped rather
  than taking out the ring, and any write failure degrades to in-memory.

### Changed

- `release.sh` now runs the 9 live-Caddy integration tests as part of its check step,
  against a **scratch** Caddy started on its own admin port (the suite's `beforeEach`
  does `loadConfig({})`, which would wipe the config of whatever is listening on 2019).
  Those tests are the only thing pinning the Caddy admin-API contracts this server is
  built on — PUT-at-an-array-index inserts, PATCH replaces an `@id` in place, stale
  `If-Match` yields 412 — and `npm test` skips every one of them unless
  `CADDY_MCP_INTEGRATION=1`, so a Caddy release that changed any of them would previously
  have shipped silently. `SKIP_INTEGRATION=1` bypasses, mirroring `SKIP_LINT`.
- The three `caddy_tls` set actions share one `setIssuerField` helper instead of three
  hand-copied PATCH-then-fallback blocks, so the clobber-safety semantics cannot drift
  between them.

### Fixed

- **String values were sent as raw request bodies on every config write.** A config
  write's body is a JSON *value*, so a string has to be JSON-encoded; caddy-mcp sent it
  bare and Caddy answered `500 {"error":"decoding request body: invalid character 'x'
  looking for beginning of value, at offset 1"}`. This broke `caddy_tls set_email` /
  `set_acme_ca` / `set_acme_profile`, and `caddy_config_set` / `caddy_config_by_id`
  whenever the value was a string. `POST /load` and `POST /adapt` still send a raw
  document (a Caddyfile must not be JSON-encoded), so the raw passthrough is now opt-in
  per call site instead of applying to every string body.
- **`caddy_tls`'s clobber-safe fallback used `PUT`, which could never succeed.** Caddy's
  `PUT` on a non-array key is strictly-create and returns `409 "key already exists: tls"`
  whenever `apps/tls` is present -- exactly the condition the fallback runs under. It now
  uses `PATCH`, which requires the key to exist. Together with the encoding bug above,
  `caddy_tls` write actions only ever succeeded against an instance that had no
  `apps/tls` block at all.

  Both were invisible to the unit tests, which mock the api module and so never see Caddy
  reject a verb or a body. The live-Caddy integration suite now pins both, and it runs in
  `release.sh`.
- A `CADDY_ADMIN_URL` that plainly means "unix socket" but does not parse as one --
  `unix:/run/caddy.sock` (a single slash) or `unix://relative.sock` -- used to fall
  through to the TCP path and report `Cannot connect to Caddy admin API at null`,
  naming neither the socket nor the mistake. It now fails immediately with the two
  accepted spellings, and without burning the retry budget on what is a static
  configuration error.
- README reported "230 unit tests; +8 live-Caddy integration tests"; the actual counts
  are 313 and 9.
- Documented that since Caddy 2.11.1, `SIGUSR1` reloads from the Caddyfile **only** if
  the config has never been changed through the admin API — so the first write from
  caddy-mcp makes `systemctl reload caddy` a silent no-op.

## [2.2.0] — 2026-08-08

### Added
- **Opt-in `--permission` sandbox.** `CADDY_MCP_SANDBOX=1` runs the server
  under oam's permission model (oam 0.9.0+). The net grant is derived from
  `CADDY_ADMIN_URL` (default `http://127.0.0.1:2019`) with host and port both
  pinned, the environment allowlist is derived from what the shipped bundle
  actually reads rather than hand-written, and filesystem and child-process
  access stay denied — this server drives Caddy entirely over its admin HTTP
  API and never shells out to the `caddy` binary. Opt-in rather than default
  because a wrong grant does not fail loudly: oam denies a non-granted
  environment variable by making it absent from `process.env` rather than
  throwing, so an under-granted secret reads as "unauthenticated" rather than
  "denied". (2.4.0 later found three faults that made the sandbox deny every
  request; see that entry.)
- **Tests that `server.json` and `package.json` agree.** `server.json` is what
  the Official MCP Registry reads at publish time; it carries the version twice
  (top-level and `packages[].version`) and `release.sh` bumps it separately
  from `package.json`, so an edit that updates one and not the other ships a
  desynced registry entry — visible to users, invisible to the release. Three
  assertions now pin top-level version parity, per-package version parity, and
  `mcpName` equal to `server.json`'s `name` (the registry keys on `name` while
  npm consumers read `mcpName`, so disagreement puts discovery and install on
  different identifiers). tailscale-mcp was the only server with this check,
  and it caught a real skew during a release there (#28).

### Changed
- **The launcher requires oam 0.9.0.** It probes `oam --version`; below the
  floor `CADDY_MCP_RUNTIME=auto` falls back to Node with a note on stderr and
  `CADDY_MCP_RUNTIME=oam` is a hard error. Older oam ran
  `child_process.execFile` arguments through a shell, accepted an `exec`
  timeout and ignored it, truncated `spawnSync` at `maxBuffer` while reporting
  success, and treated `stdio` `inherit`/`ignore` as `pipe`. (2.3.1 found that
  the version check was defined but never called, so the floor was not
  actually enforced until then; see that entry.)

## [2.1.0] — 2026-08-07

### Added
- Runtime launcher at `bin/caddy-mcp.mjs`: the published `caddy-mcp` command now prefers the [oam](https://oamjs.org) runtime and falls back to Node. `CADDY_MCP_RUNTIME` selects (`auto` / `oam` / `node`) and `OAM_BIN` overrides discovery. Both paths were verified against the full MCP surface — handshake and all 18 tools — and behave identically. Unlike npmjs-mcp this server is not a zero-dependency bundle; oam resolves `@modelcontextprotocol/sdk` and `zod` from `node_modules` without complaint.

### Changed
- `bin` points at the launcher rather than `dist/index.js`. The fallback does **not** re-exec Node — npm has already started Node to run the launcher, so it is an in-process `import()` with no extra spawn for users without oam.
- `.gitignore` excludes `bin/*` rather than `bin/`, so the launcher can be re-included with a negation. A directory-level exclusion cannot be undone by a negation for a file inside it — that trap shipped a broken `bin` in postgres-mcp, where the launcher was untracked and absent from every fresh clone.
- `scripts/build-binary.mjs` pins the CLI source entry instead of deriving it from `bin`'s value. The old derivation would have produced `bin/caddy-mcp.ts` the moment `bin` moved to the launcher — the exact breakage postgres-mcp shipped in 0.9.0. Deriving from `main` is not the fix either, since `main` is the library export (`./dist/server.js`) while the binary needs the CLI entry.

### Fixed
- Corrected the benchmark note claiming `oam run` is slower than Node (853 vs 701 ms) and "deliberately not used". That measurement timed an oam binary inside `target/release` while a concurrent `cargo build` was replacing it. Re-measured against an installed oam, interleaved, n=12 medians: node 213 ms, oam 184 ms — **0.86x**. oam is ahead even here, where `dist/` resolves its dependencies from `node_modules`; on a zero-dependency bundle the gap is wider (npmjs-mcp: 167 → 112 ms, 0.67x).
- `findOam()` prefers an installed oam (`~/.oam/bin`, `%LOCALAPPDATA%\oam\bin`) over a `target/` binary on PATH, resolves PATH hits to absolute paths, and flags `fromBuildTree` so timing-sensitive callers can warn. `$OAM_BIN` still wins outright — it is an instruction, not a hint.

## [2.0.0] — 2026-08-07

### Changed

- **BREAKING: `caddy_load` now requires `confirm=true`.** It replaces the
  entire running configuration, discarding every server and route absent from
  the supplied config, and was the only destructive tool without a
  confirmation gate. Callers that omit `confirm` now receive a refusal instead
  of a load. The prior config is still snapshotted first and is restorable via
  `caddy_revert`.

### Fixed

- **The admin API rejected every request against a stock Caddy.** Node's global
  `fetch` always sends `Sec-Fetch-Mode: cors`, which Caddy reads as a
  browser-initiated cross-origin request; it then enforces its admin origin
  allowlist, and with no `Origin` header the computed origin is `''`, which is
  never allowed. Every tool returned
  `{"error":"client is not allowed to access from origin ''"}`. Requests now
  send an `Origin` matching `CADDY_ADMIN_URL`. `curl` and `node:http` send no
  `Sec-Fetch-Mode` and were always allowed, which is why manual testing never
  surfaced this. Verified against Caddy 2.11.4.
- **`caddy_reverse_proxy` with an `id` duplicated the route instead of
  replacing it.** `/id/<id>` resolves to a position in the routes array, where
  `PUT` *inserts*; the second call appended a route carrying the same `@id` and
  Caddy rejected the whole config with `indexing config: duplicate ID`. The
  documented "repeat calls REPLACE in place (idempotent)" behavior now actually
  holds, via `PATCH`.
- **Transient-failure retries could duplicate an array element.** `PUT` at a
  path ending in an array index is no longer retried, matching the existing
  carve-out for non-idempotent `POST`.
- **The root `/config/` ETag entry was never invalidated** by a descendant
  write, so a later write to the config root sent a stale `If-Match` and
  surfaced a spurious `HTTP 412`. The ancestor check built `/config//`, which
  matched nothing.
- **A bracket-less IPv6 host in `from` was mangled** — `::1` became `:` because
  the final address group was treated as a port.
- **`caddy_status` and `caddy_list_servers` threw** on a malformed server entry
  (`null`, a string, an array) instead of rendering it.
- **A whitespace-only or scheme-only `from`** produced a route whose host
  matcher could never fire; it is now refused, and surrounding whitespace is
  trimmed rather than baked into the matcher.
- **`caddy_metrics`' description contradicted its behavior**, claiming filter
  mode drops the `# EOF` marker when the marker is always preserved.
- **`npm run build` failed.** tsup's bundled `rollup-plugin-dts` is built
  against TypeScript 5.x and crashes on TypeScript 7 while emitting
  declarations, which broke `prepublishOnly` and the release script.
  Declarations now come from `tsc -p tsconfig.build.json`.

### Added

- **Optional [oam](https://oamjs.org) toolchain support.** `npm run typecheck`
  uses `oam check` (tsgo, TypeScript 7 native) when oam is available and falls
  back to `tsc --noEmit` otherwise — 832 ms vs 8449 ms on windows-arm64, same
  `tsconfig.json`, same files. `node scripts/build-binary.mjs` can build an
  oam-carrier binary with `CADDY_MCP_RUNTIME=oam` (57.53 MB / 529 ms startup,
  against the Node SEA carrier's 75.22 MB / 808 ms), embedding the identical
  esbuild bundle.

  The binary's **default carrier remains Node SEA** so a given git tag produces
  the same artifact on every build host; oam there is opt-in, and requesting it
  without a working oam is an error rather than a silent downgrade. oam is not
  an npm dependency — a Node-only checkout builds, type-checks, and tests
  exactly as before. The published npm package and its `bin` entry still run on
  Node; `oam run` on loose source is slower than Node and is not used.
- `caddy_list_routes` output is now bounded: the summary caps at 500 routes and
  the raw JSON block at 20000 characters, truncated on whole-route boundaries
  so the block always parses. Both report how many routes were omitted.
- Live-Caddy integration coverage for the `@id` round-trip, `PUT`-inserts-at-an-
  array-index semantics, and the ETag 412 path. Run with
  `CADDY_MCP_INTEGRATION=1` against a running Caddy.

## [1.3.1] — 2026-06-11

### Added

- **Standalone single-file binaries.** Every release now builds a Node SEA
  binary natively on each supported platform — linux-x64, win32-x64,
  win32-arm64, darwin-arm64 and darwin-x64 — and attaches it to the GitHub
  Release with a `.sha256` sidecar, so the server can run without a Node
  install. Distribution is through the Scoop bucket (`scoop-yaw`) and the
  Homebrew tap (`homebrew-yaw`), whose package-manager fetch sets no
  quarantine or Mark-of-the-Web, so the unsigned (macOS: ad-hoc signed)
  binaries run without Gatekeeper or SmartScreen friction;
  `scripts/update-manifests.mjs` regenerates both manifests from the release's
  hashes. Adopted from the shared `@yawlabs` binary pipeline, with everything
  repo-specific derived from `package.json`.
- **`caddy-mcp --version` (or `-V`)** prints the version and exits before the
  stdio server starts, so the packaged binary and the CI smoke test can probe
  it.

### Changed

- The version is substituted at build time in the single-binary bundle, and
  read from `package.json` via `createRequire` only when unbundled. The SEA
  bundle is CJS, where `import.meta.url` is empty, so the previous load-time
  `createRequire(import.meta.url)` would have crashed the binary with
  `ERR_INVALID_ARG_VALUE`. Behavior on Node is unchanged.

## [1.3.0] — 2026-06-07

### Changed

- **`caddy_config_delete` and `caddy_config_by_id`'s `delete` action now
  require `confirm=true`.** Deleting a parent path removes every descendant —
  deleting `apps/http/servers/srv0` takes the server and all of its routes —
  and these were the two destructive tools without a confirmation gate.
  Callers that omit `confirm` now get a refusal naming the target instead of a
  delete (#8).
- Empty-body `401`/`403` errors hint `-- check CADDY_API_TOKEN` instead of a
  bare `HTTP 401`; Caddy behind an auth proxy answers with no body, and the
  bare code gave nothing to act on (#8).
- `caddy_remove_route` by index distinguishes a missing `routes` key
  (`no routes configured`, matching `caddy_list_routes`) from a malformed
  non-array value (#8).
- The "server does not exist" error names the tool that hit it, and the
  metrics truncation footer reports `max_lines` so callers know the knob
  exists (#8).
- Bumped the `hono` override to `^4.12.21` (resolving 4.12.23) and added a
  `qs` override at `^6.15.2`, regenerating the lockfile to clear five medium
  Dependabot alerts in the MCP SDK's transitive tree: Set-Cookie injection via
  the cookie helper, `app.mount()` undecoded-prefix routing, an IPv6 deny-rule
  bypass, the JWT middleware accepting any auth scheme, and a `qs.stringify`
  DoS on null/undefined entries in comma-format arrays. Dependabot's own
  lockfile-only updates failed because they left the `overrides` block
  inconsistent; bumping the floor and regenerating the lockfile together is
  the working fix. These overrides scope to this repo's own dependency tree;
  published consumers resolve their own from the two direct deps (#9).

### Added

- **`CADDY_TIMEOUT`** sets the timeout in ms for every admin API request other
  than `/load` (which keeps `CADDY_LOAD_TIMEOUT`). The default is unchanged at
  10s, with the same floor-then-bounds validation, so `0.5` cannot become an
  instant-abort timeout (#8).
- Ten tests for the new branches: the `CADDY_TIMEOUT` matrix including `/load`
  isolation, the empty-body token hint, and missing-vs-malformed routes (#8).

### Fixed

- `caddy://config` and `caddy://upstreams` resource reads no longer emit
  `text: undefined` on an empty body, matching the guard `caddy://servers`
  already had (#8).

## [1.2.9] — 2026-06-02

Release tooling and README only; no change to the published package's
behavior.

### Fixed

- **The README's "Add to Yaw MCP" badge is clickable again.** GitHub's Markdown
  sanitizer strips `<a href>` values whose scheme is not on its allowlist, so a
  badge linking straight to `yaw://install` rendered the image but dropped the
  link — the click did nothing. It now points at `https://yaw.sh/mcp/install`,
  which forwards the verbatim query to the `yaw://` install handler the app
  registers.
- **`release.sh` refuses to push when origin's tag has drifted from local.**
  Before pushing the bump commit and tag it queries origin for the same tag
  name and compares SHAs; if origin already has the tag at a different commit
  (rewound elsewhere, or a parallel release race) it fails with a clear message
  instead of continuing. `git push --follow-tags` silently skips a tag that
  already exists on the remote, so without the guard the main push would
  succeed, origin's tag would stay on the old SHA, and `gh release create`
  would publish a GitHub release linked to that stale commit while npm carried
  the new one. A follow-up compares tag-object SHAs on both sides, so a resume
  run of the same release no longer false-aborts against its own tag, and the
  comment describing the hazard was corrected to match the real failure mode.
- `SKIP_LINT=1` escape hatch in `release.sh` for hosts where the lint runner is
  broken: `npm`/`pnpm` `lint*` subcommands become no-ops for that run. Meant
  for the MINGW64-ARM64 case at the time, and only for a broken runner, not
  routine use.

## [1.2.8] — 2026-05-28

Release tooling and README only; no change to the published package's
behavior.

### Changed

- **Releases run end-to-end from the workstation; GitHub Actions is out of the
  release path.** The MCP Registry publish (`server.json` sync,
  `mcp-publisher` install, login, publish) moved from `release.yml` into
  `release.sh` as its own step between the GitHub release and verification,
  authenticating with `MCP_REGISTRY_TOKEN` — or, when that is unset, the
  `gh auth token` session, whose `admin:org` scope covers the `read:org` claim
  the `io.github.YawLabs/*` namespace needs. `release.yml`, `ci.yml`,
  `deprecate.yml` and the `.github/workflows` directory are deleted. Along the
  way `release.sh` keeps `server.json`'s version in sync with `package.json` on
  every invocation, not only on the bump branch: a resume run that skipped the
  bump used to leave `server.json` on the previous version, and the registry
  publish then failed with "cannot publish duplicate version".
- Before that removal, `release.sh` learned to hand off to CI instead of racing
  it: when a `v*` tag push triggers a CI publish, the workstation watches that
  run and verifies with `npm view` rather than also publishing itself, which
  had produced E409 "cannot publish over previously published" on a lost race
  and E404 on a stale `~/.npmrc` session. A review pass then tightened the
  handoff — the CI-detection grep no longer matches any workflow that merely
  runs `release.sh`, the run-id lookup backs off exponentially, npm
  propagation verification runs up to 60s and warns rather than fails, the tag
  is verified on origin before the run lookup, and a resume warns if the most
  recent Release run for the tag did not succeed. Superseded within this same
  version by the workstation-only flow above.
- `release.sh`'s "Continue?" prompt is gated on stdin being a TTY, so headless
  invocations proceed (with an info line) instead of aborting under
  `set -euo pipefail`; and `npm pkg fix` normalized the `bin` path to
  `dist/index.js`, silencing the "script name ... was invalid and removed"
  warning npm printed on every publish.
- README: the install badge is an "Add to Yaw MCP" `yaw://install` deep link
  that fires Yaw Terminal's local protocol handler (which shows a confirmation
  dialog with the verbatim command, args, env keys and source before writing
  `~/.yaw-mcp/config.json`), replacing the mcp.hosting cloud-account badge; and
  the `npx` spawn is pinned to `@latest`, so each MCP session re-resolves
  against the registry and picks up the newest published version instead of
  whatever sits in the npx metadata cache.

## [1.2.7] — 2026-05-19

### Fixed

- **Prefix-aware ETag cache invalidation.** A successful write at path `P` now
  also drops cached ETags for ancestors of `P` (e.g. a write to
  `apps/http/servers/srv0/routes` invalidates a cached
  `apps/http/servers/srv0`), descendants of `P`, and the cross-namespace
  entries (a `/id/<id>` write invalidates every `/config/...` entry, and a
  `/config/...` write invalidates every `/id/<id>` entry). Previously
  invalidation was path-exact, so a sequence of "GET parent / write child /
  write parent" sent a stale `If-Match` on the parent write and surfaced a
  spurious `HTTP 412 Precondition Failed` to the caller.
- **Resource error responses now report `text/plain`.** When the admin API
  call backing `caddy://config`, `caddy://upstreams`, or `caddy://servers`
  fails, the body is `Error: ...` text but `mimeType` was still
  `application/json` -- a strict client doing `JSON.parse` on the body
  would crash. `caddy://metrics` already handled this correctly.

## [1.2.6] — 2026-05-16

### Fixed

- **Revert the `caddy_reverse_proxy` @id PUT "parent-missing -> server-not-found"
  translation introduced in 1.2.5.** A 404 on `PUT /id/<id>` is far more often
  caused by a concurrent `caddy_remove_route` deleting the @id between the GET
  and PUT than by the parent server being torn down; the friendly message
  mislabelled the routine race. PUT failures now surface verbatim again, as
  they did pre-1.2.5.

## [1.2.5] — 2026-05-16

### Fixed

- **`caddy_status` no longer misclassifies non-443 ports as HTTPS-auto.** A
  naive `:443` substring match also fired for neighbors like `:4430` /
  `:4431`. Replaced with a boundary-aware regex that still recognizes
  `:443/h3` (QUIC protocol annotation) and bound addresses like
  `127.0.0.1:443`.
- **`caddy_reverse_proxy` with `@id`: friendlier error when the parent
  server is torn down between the GET and PUT.** The narrow TOCTOU now
  surfaces the standard "server does not exist" message rather than the raw
  `key does not exist` body. **(Reverted in 1.2.6 -- it mislabelled the
  more common "@id was deleted" race.)**

### Changed

- **`CADDY_MAX_RETRIES` clamp is now visible.** Values above the hard cap
  (5) log a one-time stderr notice so a `CADDY_MAX_RETRIES=1000` setter
  doesn't silently get 5.
- **Dropped a stale doc claim** on `cleanUpstreamAddr` -- the helper strips
  scheme and trailing slashes, it does not validate host:port.

## [1.2.4] — 2026-05-15

### Added

- **Published to the Official MCP Registry.** Each release is now submitted to
  registry.modelcontextprotocol.io as `io.github.YawLabs/caddy-mcp`: a
  `server.json` describes the server and its npm package, `package.json`
  carries the matching `mcpName`, and the release workflow publishes it with
  OIDC — the `id-token: write` permission already granted for npm provenance
  covers the registry too, so there is no registry secret to manage. This
  version exists to exercise that step end to end.

### Changed

- README documents the 1.2.3 behavior: `CADDY_MAX_RETRIES` notes that POSTs to
  `/config/*` and `/id/*` skip retry, `caddy://metrics` notes its 500-line
  cap, and the test count is 182.

## [1.2.3] — 2026-05-15

### Fixed

- **Non-idempotent POSTs are no longer retried.** The retry policy is split by
  method and path: a POST to `/config/*` or `/id/*` appends or creates, so
  retrying a request whose first attempt may have landed could duplicate a
  route or 409 a half-applied create. POSTs to `/load`, `/adapt` and `/stop`
  still retry under the normal transient-failure rules.
- **`caddy_reverse_proxy` strips an explicit `:port` from the `from` host.**
  Caddy host matchers compare against the `Host` header with the port
  removed, so `example.com:8080` produced a matcher that never fired. The IPv6
  bracket form is handled and a non-numeric suffix is left alone.
- **`caddy://metrics` is capped.** The resource dumped the unbounded metrics
  body; it now goes through the same controls as `caddy_metrics` (500 lines by
  default). When truncation drops the `# EOF` marker in the tail, the marker
  is re-emitted so the output stays a well-formed Prometheus exposition.
- **`caddy_load` snapshots the prior config only after the load succeeds**,
  mirroring `caddy_revert apply`: a failed load changed nothing server-side,
  so pushing a snapshot for it only consumed a slot in the 10-deep ring and
  shifted the earlier rollback targets one position deeper.
- `caddy_adapt`'s adapter-name check is case-sensitive: Caddy registers
  adapters in lowercase, so `Caddyfile` is rejected up front rather than sent
  on to fail.
- README's "Add to mcp.hosting" install link dropped the sensitive env
  parameter the `/install` parser rejects.

### Added

- `deprecate.yml`: a `workflow_dispatch` workflow that runs `npm deprecate`
  from CI with the org `NPM_TOKEN`, so deprecating a version range needs no
  local WebAuthn session; its verify step retries the public-registry view to
  outlast CDN propagation lag.

## [1.2.2] — 2026-05-13

Documentation only; no change to the published package's behavior.

### Changed

- `caddy_adapt`'s description and the README say it accepts any adapter module
  Caddy was built with — `caddyfile` (built in), `nginx` via
  caddy-nginx-adapter, `yaml` via caddy-yaml — instead of implying Caddyfile
  plus a vague "or other config format". Users porting from nginx or yaml did
  not know one tool already covered it.

## [1.2.1] — 2026-05-13

### Changed

- Bumped the `hono` override to `^4.12.18` and added a `fast-uri` override at
  `^3.1.2`, regenerating the lockfile to clear seven Dependabot alerts (two
  high in `fast-uri`, five medium/low in `hono`). Both are transitive — `hono`
  via the MCP SDK and `@hono/node-server`, `fast-uri` via `ajv` — and the
  existing `hono` override allowed the patch range while the lockfile stayed
  pinned to 4.12.14. Runtime impact for this server is nil: the stdio
  transport does not expose the affected surface.
- README documents `CADDY_LOAD_TIMEOUT` in the environment-variable table. It
  shipped in 1.2.0 but was missing there, so users hitting ACME-heavy `/load`
  timeouts would not have found the escape hatch.

## [1.2.0] — 2026-05-13

### Added

- **`CADDY_LOAD_TIMEOUT`** overrides the `/load` timeout (default 60s) for
  ACME-heavy bring-ups, where provisioning many certificates can exceed the
  default. The value is floored before it is bounds-checked, so
  `CADDY_LOAD_TIMEOUT=0.5` falls back to the default instead of slipping past
  the `n > 0` check as a 0ms instant-abort timeout.
- Live-Caddy integration test for the `@id` contract `caddy_reverse_proxy`
  depends on — a POST with `@id` embedded registers it, `GET /id/<unknown>` is
  non-OK, `PUT /id/<known>` replaces in place — so a Caddy version that changes
  `@id` semantics is caught.
- `.github/workflows/ci.yml`: lint, typecheck, build and test on Node 20 and
  22 for every push to `main` and every PR. The build step is deliberate:
  vitest runs from source and never exercises tsup, so an explicit build
  catches bundler errors at PR time rather than release time.
- README covers the 1.1.0 tool surface: `caddy_reverse_proxy`'s `id` parameter,
  `caddy_metrics`' `filter` and `max_lines`, and `caddy_tls`'s deep-merge and
  refuse-on-shape behavior, with two new examples.

### Fixed

- **`caddy_revert apply` defers its pre-revert snapshot until `/load`
  succeeds**, so a failed revert no longer shifts `apply 0` onto the failed
  attempt's pre-state.
- **`caddy_load` and `caddy_revert save` only snapshot non-null object
  bodies.** Empty strings, arrays and primitives cannot be replayed through
  `/load`; `save` now reports an empty or non-JSON-object body rather than the
  misleading "no config loaded".
- **`caddy_metrics` filter mode preserves `# EOF`**, including on CRLF input
  and with trailing whitespace, so strict Prometheus parsers do not break on
  filtered output.
- `caddy_status` reads the ACME email strictly from
  `policies[0].issuers[0].email`, the field `caddy_tls set_email` writes, so
  the two agree.

### Changed

- **Publishing moved to CI on tag push.** The local-only path required an
  active npm WebAuthn session in `~/.npmrc`, which expires silently and
  produces a misleading 404 on publish; `release.yml` now fires on `v*` tags
  and publishes with the org `NPM_TOKEN`, with `workflow_dispatch` as an
  escape hatch, and `release.sh` learned a CI mode that derives the version
  from the tag and gates `--provenance` on CI, where OIDC signing is
  available. Tags are annotated so `git push --follow-tags` actually pushes
  them (lightweight tags are silently skipped), `--follow-tags` replaces
  `--tags` so stale local tags do not ride along, the npm idempotency check
  pins the exact version instead of asking for `latest`, and the workflow's
  concurrency group is a literal `release-npm` rather than a per-tag key that
  serialized nothing.
- Pinned `ip-address` to `>=10.1.1` (transitive via the MCP SDK and
  `express-rate-limit`) to clear GHSA-v2v4-37r5-5v8g; the advisory is XSS in
  `Address6`'s HTML-emitting methods and this server emits no HTML, so the
  functional impact is nil.

## [1.1.0] — 2026-05-06

### Added

- **`caddy_reverse_proxy` takes an optional `id`** for stable `@id`-keyed
  routes. It reads first: when the `@id` resolves to a route it replaces in
  place, when it resolves to something that is not a route it refuses rather
  than clobbering it, and on first create it registers via POST. (2.0.0 later
  found the in-place replace used `PUT`, which inserts at an array position,
  and moved it to `PATCH`; see that entry.)
- **`caddy_metrics` takes `filter`** (a metric-name substring) **and
  `max_lines`** (default 500) to bound the output; `HELP`/`TYPE` lines for the
  retained metrics are preserved.

### Fixed

- **`caddy_tls`'s PATCH fallback no longer clobbers an existing `apps/tls`.**
  It deep-merges into the issuer path and writes the result back, preserving
  siblings such as `on_demand`, `certificate_authorities` and additional
  policies, and refuses with a shape-specific error when the structure is not
  what it expects.
- The ETag cache is refreshed per method on writes — `PATCH`/`PUT` refresh the
  entry, `POST`/`DELETE` invalidate it — and path-traversal rejection is
  extended to `caddy_config_by_id`'s `id` and the `ca` argument of the PKI
  reads.
- A bare trailing slash in `from` is dropped: `example.com/` is a host-only
  matcher now, where before the `/` path matched only the literal root.

### Changed

- Releases run through `release.sh` alone — bump, commit, tag, push,
  `npm publish --provenance`, `gh release create` — with the GitHub Actions
  workflows removed; the README's CI and release badges went with them.
  (Reinstated in 1.2.0.)
- Pinned `postcss` to `>=8.5.10` (transitive via tsup and vitest) to clear a
  moderate XSS advisory; `npm audit` reports 0 vulnerabilities.

## [1.0.1] — 2026-04-24

### Security

- **Reject `..` segments in config paths.** `caddy_config_get/set/delete` and
  `caddy_config_by_id` (subpath) now return an error on paths containing `..`
  segments, so config-scoped tools can't reach sibling admin endpoints like
  `/load` or `/stop`.

### Fixed

- **`caddy_remove_route` no longer claims ETag protection it doesn't provide.**
  The index-based branch reads the parent routes array and deletes a child path;
  the ETag cache keys didn't match, so `If-Match` was never sent. Tool
  description and inline comment corrected — prefer `@id`-based removal for
  concurrent-edit safety.
- **`caddy_revert action="save"` guards against `undefined` data**, matching
  `caddy_load` and the `apply` branch. Avoids a later `JSON.stringify`
  exception on listing.

### Changed

- **Build target bumped from node18 to node20** to match `engines.node >=20`.

## [1.0.0] — 2026-04-20

First stable release. API surface is now frozen under semver.

### Added

- **Retry/backoff in the admin client** — transient network errors and 5xx responses
  retry with exponential backoff (base 100ms, capped at 2s per retry) plus jitter.
  Configurable via `CADDY_MAX_RETRIES` (default: 2, hard cap: 5). 4xx and 412 never
  retry.
- **`caddy_revert` tool** — config snapshots for rollback. Snapshots are auto-captured
  before every `caddy_load` and kept in-memory (last 10). Actions: `list`, `save`,
  `apply` (confirm-gated).
- **Live-Caddy integration tests in CI** — new `integration` job spins up a real Caddy
  binary, exercises the full admin API surface (load, adapt, route CRUD, ETag 412,
  `@id` paths).
- **CHANGELOG.md**.

### Changed

- Tighter types in `operational.ts` and `adapt.ts` — replaced residual `any` usage
  with typed shapes and runtime narrowing.
- Tool count: 18 (was 17).

### Fixed

- Test drift: `expectedTools` list was missing `caddy_remove_route`; one
  resource-count assertion described "2" while asserting 4.

## [0.3.1] — 2026-04-18

### Fixed

- `hono` / `@hono/node-server` overrides pinned to resolve MCP SDK transitive
  peer-dep warnings.
- `engines.node` bumped to `>=20` to match the MCP SDK's minimum.

## [0.3.0] — 2026-04-16

### Added

- `caddy_remove_route` tool — remove a route by `@id` (preferred) or by array index.
  Confirm-gated.
- Two additional MCP resources: `caddy://servers`, `caddy://metrics`.
- Full README rewrite.

## [0.2.0] — 2026-04-10

### Added

- Input hardening: regex validation + length caps on adapter names, `@id`, server
  names, and CA ids. Blocks CRLF header injection and ReDoS.
- Defensive parsing in `caddy_list_routes` — never crashes on malformed config
  (null routes, non-array matchers/handlers, wrong types).
- `overwrite` as the default mode for `caddy_config_set` (was `append`) — idempotent
  by default.
- Fallback error surfacing for TLS writes — when PATCH fails and POST fallback
  also fails, both error bodies are returned.
- `append` and `insert` modes on `caddy_config_by_id`.
- ETag concurrency control extended to `/id/` paths.
- Credential scrubbing in connect-failed errors — only the origin is shown, not
  path or query.

## [0.1.1] — 2026-04-10

### Added

- **Three new tools (13 → 16):** `caddy_config_by_id` (get/set/delete through
  Caddy's `/id/<id>` endpoint), `caddy_list_servers` (server names, listen
  addresses and route counts) and `caddy_metrics` (Prometheus metrics from
  `/metrics`).
- **ETag-based optimistic concurrency on config writes**, on `/id/` paths as
  well as `/config/` paths, so a write on a stale read fails with 412 rather
  than clobbering a concurrent change.
- `caddy_load` accepts a Caddyfile via the `text/caddyfile` content type, with
  a 60s timeout for certificate provisioning; `caddy_config_set`'s modes are
  `append`, `overwrite` and `insert`, the last a new `PUT` mode for array
  positions.
- Regex input validation on the `server`, `ca` and `id` parameters.

### Fixed

- `normalizePath` no longer corrupts paths that start with `config`.
- `caddy_tls` falls back to `POST` when `PATCH` fails on a fresh Caddy
  instance that has no `apps/tls` yet.
- No `Content-Type` header is sent on bodyless `GET`/`DELETE` requests.
- `from` has its `http://`/`https://` scheme stripped before parsing, and
  upstream addresses are stripped of schemes and trailing slashes.
- Removed a duplicate entry-point auto-start in `server.ts`.
- An actionable error when the target server does not exist, instead of
  Caddy's raw body.

### Changed

- `caddy_list_routes` shows `@id`, `group`, and more matcher and handler
  detail; `caddy_adapt` separates warnings from the adapted JSON;
  `caddy_status` distinguishes enabled, automatic and HTTP-only TLS; an empty
  response renders as `OK` instead of a blank result.
- Dependencies moved to their latest majors — zod 3 → 4, TypeScript 5 → 6,
  Biome 1 → 2, vitest 3 → 4 — and the README lists the three tools it was
  missing with the corrected count.
- Tests: 23 → 67, with behavioral tests for every tool handler.

## [0.1.0] — Initial release

- 13 MCP tools covering the Caddy admin API: config get/set/delete/load, reverse
  proxy, add route, list routes, adapt, TLS, status, upstreams, PKI, metrics, stop.
- stdio transport, MCP tool annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`).

[2.4.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v2.4.1
[2.2.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v2.2.0
[1.3.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.3.1
[1.3.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.3.0
[1.2.9]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.9
[1.2.8]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.8
[1.2.4]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.4
[1.2.3]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.3
[1.2.2]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.2
[1.2.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.1
[1.2.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.0.0
[0.3.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.1.0
