# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** versions 1.1.0 through 1.2.4 were released without changelog
> entries. See the [git tag list](https://github.com/YawLabs/caddy-mcp/tags)
> and release notes for those versions.

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
  `key does not exist` body.

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
