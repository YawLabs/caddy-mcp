import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiResponse } from "./api.js";
import * as api from "./api.js";
import { applyMetricsControls, METRICS_DEFAULT_MAX_LINES, metricsBodyText } from "./tools/operational.js";

/**
 * Error body for a failed resource read. Mirrors the tool-side fallback in
 * format.ts: `error` is optional on ApiResponse, and only the failure paths
 * api.ts builds itself are guaranteed to fill it -- so interpolating it bare
 * renders the literal string "Error: undefined" to the client. Falling back to
 * the status code at least tells the caller what the server said.
 */
function errorText(res: ApiResponse): string {
  return `Error: ${res.error || `HTTP ${res.status}`}`;
}

export function registerResources(server: McpServer) {
  server.resource("caddy-config", "caddy://config", { description: "Current Caddy JSON configuration" }, async () => {
    const res = await api.configGet();
    return {
      contents: [
        {
          uri: "caddy://config",
          mimeType: res.ok ? "application/json" : "text/plain",
          text: res.ok ? JSON.stringify(res.data ?? {}, null, 2) : errorText(res),
        },
      ],
    };
  });

  server.resource(
    "caddy-upstreams",
    "caddy://upstreams",
    {
      description:
        "Reverse proxy upstream health: Caddy's /reverse_proxy/upstreams array, returned verbatim. " +
        "On Caddy 2.11.2+ it is not the configured upstream list -- dynamic upstreams stay listed about 1 h after " +
        "the dynamic source last returned them (so an address can outlive the config that referenced it), and a " +
        "backend with requests in flight can appear twice when its resolved address differs from the entry's text. " +
        "The extra copy always shows fails 0 and repeats num_requests, so do not sum num_requests. " +
        "See the caddy_upstreams tool for the full caveat.",
    },
    async () => {
      const res = await api.getUpstreams();
      return {
        contents: [
          {
            uri: "caddy://upstreams",
            mimeType: res.ok ? "application/json" : "text/plain",
            text: res.ok ? JSON.stringify(res.data ?? {}, null, 2) : errorText(res),
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
              text: errorText(res),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: "caddy://metrics",
            mimeType: "text/plain",
            text: applyMetricsControls(metricsBodyText(res.data), undefined, METRICS_DEFAULT_MAX_LINES),
          },
        ],
      };
    },
  );

  server.resource(
    "caddy-servers",
    "caddy://servers",
    {
      description:
        "Raw JSON config of every HTTP server: the object at apps/http/servers, keyed by server name ({} when none are configured). " +
        "Use the caddy_list_servers tool for a one-line summary of each.",
    },
    async () => {
      const res = await api.configGet<Record<string, unknown>>("apps/http/servers");
      // A Caddy with no http app (or no config at all) answers this GET with 400
      // "invalid traversal path", which is not a failure to read the servers but
      // the fact that there are none -- the same reading caddy_list_servers gives it.
      const none = api.isMissingConfigPath(res);
      const asJson = res.ok || none;
      return {
        contents: [
          {
            uri: "caddy://servers",
            mimeType: asJson ? "application/json" : "text/plain",
            text: asJson ? JSON.stringify((res.ok ? res.data : undefined) ?? {}, null, 2) : errorText(res),
          },
        ],
      };
    },
  );
}
