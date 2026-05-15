import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";
import { applyMetricsControls, METRICS_DEFAULT_MAX_LINES } from "./tools/operational.js";

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

  server.resource(
    "caddy-metrics",
    "caddy://metrics",
    {
      description:
        "Prometheus metrics (text exposition format). Capped at the same default line count as the caddy_metrics tool -- on busy servers the raw body can be megabytes. Use the caddy_metrics tool for filtered or larger output.",
    },
    async () => {
      const res = await api.getMetrics();
      if (!res.ok) {
        return {
          contents: [
            {
              uri: "caddy://metrics",
              mimeType: "text/plain",
              text: `Error: ${res.error}`,
            },
          ],
        };
      }
      const raw = typeof res.data === "string" ? res.data : res.data !== undefined ? String(res.data) : "";
      return {
        contents: [
          {
            uri: "caddy://metrics",
            mimeType: "text/plain",
            text: applyMetricsControls(raw, undefined, METRICS_DEFAULT_MAX_LINES),
          },
        ],
      };
    },
  );

  server.resource(
    "caddy-servers",
    "caddy://servers",
    { description: "Summary of all configured HTTP servers" },
    async () => {
      const res = await api.configGet<Record<string, unknown>>("apps/http/servers");
      return {
        contents: [
          {
            uri: "caddy://servers",
            mimeType: "application/json",
            text: res.ok ? JSON.stringify(res.data ?? {}, null, 2) : `Error: ${res.error}`,
          },
        ],
      };
    },
  );
}
