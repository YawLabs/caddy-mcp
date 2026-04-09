import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("caddy-mcp error:", err);
  process.exit(1);
});
