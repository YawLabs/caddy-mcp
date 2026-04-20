# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
