# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** versions 1.1.0 through 1.2.4 were released without changelog
> entries. See the [git tag list](https://github.com/YawLabs/caddy-mcp/tags)
> and release notes for those versions.

## [Unreleased]

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

## [0.1.0] — Initial release

- 13 MCP tools covering the Caddy admin API: config get/set/delete/load, reverse
  proxy, add route, list routes, adapt, TLS, status, upstreams, PKI, metrics, stop.
- stdio transport, MCP tool annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`).

[1.0.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v1.0.0
[0.3.1]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/YawLabs/caddy-mcp/releases/tag/v0.1.0
