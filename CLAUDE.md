# caddy-mcp

MCP server for managing Caddy web servers via the admin API. 13 tools across config management, route operations, TLS, and server operations.

## Architecture

- `src/index.ts` — CLI entry point. Starts stdio MCP server.
- `src/server.ts` — Creates McpServer, registers all tools and resources. Exports `createCaddyServer()` and `startServer()`.
- `src/api.ts` — Caddy admin API client (fetch wrapper). All tools call through this. Env vars: `CADDY_ADMIN_URL` (default: `http://localhost:2019`), `CADDY_API_TOKEN` (optional Bearer token).
- `src/format.ts` — Converts API responses to MCP tool result format.
- `src/tools/config.ts` — Low-level config CRUD: get, set, delete, load.
- `src/tools/routes.ts` — Route management: reverse_proxy shortcut, add_route, list_routes.
- `src/tools/adapt.ts` — Config format conversion (Caddyfile → JSON).
- `src/tools/tls.ts` — TLS/HTTPS settings management.
- `src/tools/operational.ts` — Status, upstreams, PKI, stop.
- `src/resources.ts` — MCP resources: caddy://config, caddy://upstreams.

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
