# caddy-mcp

MCP server for managing Caddy web servers via the admin API. 18 tools across config management, route operations, TLS, and server operations.

## Architecture

- `src/index.ts` — CLI entry point. Starts stdio MCP server.
- `src/server.ts` — Creates McpServer, registers all tools and resources. Exports `createCaddyServer()` and `startServer()`.
- `src/api.ts` — Caddy admin API client (fetch wrapper). All tools call through this. Also owns the retry policy (only idempotent method/path pairs retry) and the ETag `If-Match` cache used for optimistic concurrency.
- `src/format.ts` — Converts API responses to MCP tool result format.
- `src/snapshots.ts` — Ring of the last 10 config snapshots (module-level, per-process). Backs `caddy_revert`; auto-captured before `caddy_load`. In-memory by default; `CADDY_MCP_SNAPSHOT_DIR` persists them to disk and rehydrates on first access, so rollback survives a restart.
- `src/tools/config.ts` — Low-level config CRUD: get, set, delete, load, revert, config_by_id.
- `src/tools/routes.ts` — Route management: reverse_proxy shortcut, add_route, list_routes, remove_route.
- `src/tools/adapt.ts` — Config format conversion (Caddyfile → JSON).
- `src/tools/tls.ts` — TLS/HTTPS settings management.
- `src/tools/operational.ts` — Status, list_servers, upstreams, PKI, metrics, stop.
- `src/resources.ts` — MCP resources: caddy://config, caddy://upstreams, caddy://metrics, caddy://servers.

## Runtime: oam for the dev loop, Node for artifacts

[oam](https://oamjs.org) is **not** an npm dependency and is never assumed present.
Discovery lives in `scripts/runtime.mjs`: `$OAM_BIN`, then `oam` on PATH, then Node.

The split is deliberate — **auto-detect for tools, explicit for artifacts**:

| Task | Default | Alternate |
|---|---|---|
| `npm run typecheck` | `oam check .` if available, else `tsc --noEmit` | `CADDY_MCP_RUNTIME=node` forces tsc; `typecheck:tsc` pins it |
| `node scripts/build-binary.mjs` | **Node SEA + postject** | `CADDY_MCP_RUNTIME=oam` builds the oam carrier |
| `npm test` | vitest (Node) | — |
| `npm start` / `bin` entry | Node | — |

**Why the binary does NOT auto-detect.** It is a release artifact. If the carrier were
chosen by what happens to be installed, the same git tag would produce a 57 MB oam binary
on one machine and a 75 MB SEA binary on another, silently. So oam is opt-in there, and
`CADDY_MCP_RUNTIME=oam` with no working oam is a hard **error** rather than a quiet
downgrade to a different artifact. Type-checking auto-detects because it emits nothing —
a type error is a type error under either checker.

**oam is currently a local dev build**, not a published release. Anyone without it gets
the Node path everywhere, which is the default for the shipped binary anyway.

Measured on windows-arm64, 7-run averages:

| | startup | size |
|---|---|---|
| `node dist/index.js` | 730 ms | needs node + node_modules |
| Node SEA binary | 808 ms | 75.22 MB |
| **oam compiled binary** | **529 ms** | **57.53 MB** |
| `tsc --noEmit` | 8449 ms | — |
| **`oam check .`** | **832 ms** | — |

Two deliberate non-changes:

- **`oam run` is not used anywhere.** On loose source it is *slower* than Node
  (853 ms vs 701 ms) — the compiled binary's win comes from bytecode produced at
  compile time, not from the runtime itself. Making oam the launcher for
  `dist/index.js` would be a startup regression.
- **Tests stay on vitest.** oam ships its own runner (`import 'oam:test'`), but the
  suite leans on `vi.mock` for module-level api mocking; porting it would trade a
  working 310-test suite for a rewrite and would break the Node-only path.

## Environment variables

Read by `src/api.ts`. All optional.

| Var | Default | Purpose |
|---|---|---|
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Admin API base URL. Trailing slashes stripped. A `unix:///path` or `unix//path` value switches the transport from global `fetch` to `node:http` with `socketPath` — `fetch` cannot dial a unix socket. The unix path deliberately sends **no** `Origin` header: Caddy builds no default origin allowlist for a unix/fd admin listener and only runs its origin check when `Origin` or `Sec-Fetch-Mode` is present, so sending one opts into a check against an empty list and always 403s. |
| `CADDY_API_TOKEN` | (unset) | Sent as `Authorization: Bearer <token>` when present. |
| `CADDY_TIMEOUT` | `10000` | Per-request timeout in ms. Values that floor below 1 fall back to the default. |
| `CADDY_LOAD_TIMEOUT` | `60000` | Timeout for `POST /load` only — larger to allow for TLS provisioning. |
| `CADDY_MAX_RETRIES` | `2` | Retries on transient failures (network error or 5xx). Hard-capped at 5; exceeding the cap warns once on stderr. Never retries 4xx, including 412. |
| `CADDY_MCP_SNAPSHOT_DIR` | (unset) | Persist `caddy_revert` snapshots here instead of memory-only. Opt-in because snapshots are full configs and can carry secrets. Write failures degrade to in-memory rather than failing the tool call. |

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

## Parallel sessions: use a worktree per session

Two agent sessions sharing this checkout collide in two ways that are easy to
miss and expensive to unpick: one session's `git checkout` moves HEAD under the
other mid-task, and an untracked work-in-progress file gets swept into the other
session's `git add`. Both happened here on 2026-08-23.

Give each session its own worktree instead:

```bash
git worktree add ../caddy-mcp-worktrees/session-c -b session-c main
cd ../caddy-mcp-worktrees/session-c && npm ci
git worktree list          # see them all
git worktree remove ../caddy-mcp-worktrees/session-c
```

Each worktree has its own HEAD, branch, and working tree, backed by the one
shared `.git`, so branches and commits are visible everywhere immediately.

**Worktrees must live OUTSIDE this directory** -- `../caddy-mcp-worktrees/`, not
`.claude/worktrees/`. `vitest.config.ts` sets no `include`, so vitest uses its
default `**/*.{test,spec}.?(c|m)[jt]s?(x)` glob: a worktree nested anywhere under
the repo root makes `npm test` in the MAIN checkout discover every worktree's
copy of the suite. Being in `.gitignore` does not help -- vitest does not consult
it (`vcs.useIgnoreFile` is unset in `biome.json` too).

Each worktree needs its own `npm ci` (~170 MB). Do not share one `node_modules`
via a symlink or junction: that reintroduces exactly the shared mutable state the
worktrees exist to remove.
