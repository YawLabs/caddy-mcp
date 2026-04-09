import type { ApiResponse } from "./api.js";

/** Convert an API response to MCP tool result format */
export function formatResult(res: ApiResponse) {
  if (!res.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${res.error || `HTTP ${res.status}`}` }],
    };
  }
  const text =
    res.data !== undefined ? (typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2)) : "OK";
  return { content: [{ type: "text" as const, text }] };
}
