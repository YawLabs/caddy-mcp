import { startServer, version } from "./server.js";

// Print version and exit before starting the stdio server, so the packaged
// single-file binary (and the CI smoke test) can probe it with `--version`.
const subcommand = process.argv[2];
if (subcommand === "--version" || subcommand === "-V") {
  process.stdout.write(`caddy-mcp ${version}\n`);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("caddy-mcp error:", err);
  process.exit(1);
});
