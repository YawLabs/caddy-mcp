# caddy-mcp

MCP server for managing Caddy web servers via the admin API. 18 tools across config management, route operations, TLS, and server operations.

## Architecture

- `src/index.ts` — CLI entry point. Starts stdio MCP server.
- `src/server.ts` — Creates McpServer, registers all tools and resources. Exports `createCaddyServer()` and `startServer()`.
- `src/api.ts` — Caddy admin API client (fetch wrapper). All tools call through this. Also owns the retry policy (only idempotent method/path pairs retry) and the ETag `If-Match` cache used for optimistic concurrency.
- `src/format.ts` — Converts API responses to MCP tool result format.
- `src/snapshots.ts` — In-memory ring of the last 10 config snapshots (module-level, per-process). Backs `caddy_revert`; auto-captured before `caddy_load`.
- `src/tools/config.ts` — Low-level config CRUD: get, set, delete, load, revert, config_by_id.
- `src/tools/routes.ts` — Route management: reverse_proxy shortcut, add_route, list_routes, remove_route.
- `src/tools/adapt.ts` — Config format conversion (Caddyfile → JSON).
- `src/tools/tls.ts` — TLS/HTTPS settings management.
- `src/tools/operational.ts` — Status, list_servers, upstreams, PKI, metrics, stop.
- `src/resources.ts` — MCP resources: caddy://config, caddy://upstreams, caddy://metrics, caddy://servers.

## Environment variables

Read by `src/api.ts`. All optional.

| Var | Default | Purpose |
|---|---|---|
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Admin API base URL. Trailing slashes stripped. |
| `CADDY_API_TOKEN` | (unset) | Sent as `Authorization: Bearer <token>` when present. |
| `CADDY_TIMEOUT` | `10000` | Per-request timeout in ms. Values that floor below 1 fall back to the default. |
| `CADDY_LOAD_TIMEOUT` | `60000` | Timeout for `POST /load` only — larger to allow for TLS provisioning. |
| `CADDY_MAX_RETRIES` | `2` | Retries on transient failures (network error or 5xx). Hard-capped at 5; exceeding the cap warns once on stderr. Never retries 4xx, including 412. |

## Build

- **Bundler:** tsup (CLI with shebang, library with types).
- **Linter:** Biome.
- **Tests:** Vitest.
- **TypeScript:** Strict mode, ES2022, ESM.

## Commands

```bash
npm run build      # Compile with tsup
npm run dev        # Watch mode
npm test           # Run vitest
npm run lint       # Biome check
npm run lint:fix   # Biome auto-fix
npm run typecheck  # tsc --noEmit
npm run test:ci    # Build + test
```
