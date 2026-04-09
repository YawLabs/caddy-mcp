import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";

export function registerResources(server: McpServer) {
  server.resource("caddy-config", "caddy://config", { description: "Current Caddy JSON configuration" }, async () => {
    const res = await api.configGet();
    return {
      contents: [
        {
          uri: "caddy://config",
          mimeType: "application/json",
          text: res.ok ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}`,
        },
      ],
    };
  });

  server.resource(
    "caddy-upstreams",
    "caddy://upstreams",
    { description: "Reverse proxy upstream health status" },
    async () => {
      const res = await api.getUpstreams();
      return {
        contents: [
          {
            uri: "caddy://upstreams",
            mimeType: "application/json",
            text: res.ok ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}`,
          },
        ],
      };
    },
  );
}
