import type { ApiResponse } from "./api.js";

/** The fields Caddy's config-adapter Warning carries (caddyconfig/configadapters.go at v2.11.4). */
const WARNING_KEYS = new Set(["file", "line", "directive", "message"]);

/**
 * One config-adapter warning as a line, in the form Caddy's own
 * `Warning.String()` prints: `file:line (directive): message`. Every field is
 * `omitempty` on Caddy's side, so each part appears only when it was sent -- the
 * common "Caddyfile input is not formatted" warning has no directive.
 *
 * Lossless by construction. The readable form is used only for an object made
 * of exactly the fields above, correctly typed, with a message to show.
 * Anything else -- a non-object, a field of the wrong type, a key this code has
 * never seen -- is printed as its JSON, so a warning shape a later Caddy adds to
 * is shown whole instead of being trimmed down to the parts recognized here.
 */
function formatWarning(w: unknown): string {
  const asJson = () => `  - ${JSON.stringify(w)}`;
  if (w === null || typeof w !== "object" || Array.isArray(w)) return asJson();
  const obj = w as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !WARNING_KEYS.has(key))) return asJson();
  const { file, line, directive, message } = obj;
  if (typeof message !== "string" || message === "") return asJson();
  if (file !== undefined && typeof file !== "string") return asJson();
  if (line !== undefined && typeof line !== "number") return asJson();
  if (directive !== undefined && typeof directive !== "string") return asJson();

  const where = file && line !== undefined ? `${file}:${line}` : file || (line !== undefined ? `line ${line}` : "");
  const prefix = [where, directive ? `(${directive})` : ""].filter(Boolean).join(" ");
  return `  - ${prefix ? `${prefix}: ` : ""}${message}`;
}

/** The warnings block appended to a result, or "" when there is nothing to show. */
function formatWarnings(warnings: unknown[] | undefined): string {
  if (!warnings || warnings.length === 0) return "";
  return `\n\nAdapter warnings (${warnings.length}):\n${warnings.map(formatWarning).join("\n")}`;
}

/**
 * Convert an API response to MCP tool result format.
 *
 * `warnings` are appended to the SAME text item as the result, on a success and
 * on an error alike, rather than sent as a second content item. They are set
 * only by `POST /load` today, where they matter most on the failure path -- a
 * load Caddy refused, reported next to the adapter warnings that came with it --
 * and a client that reads only `content[0]` must still see both. Rendering them
 * here, not in caddy_load, means no consumer of an ApiResponse can drop them.
 */
export function formatResult(res: ApiResponse) {
  const warnings = formatWarnings(res.warnings);
  if (!res.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${res.error || `HTTP ${res.status}`}${warnings}` }],
    };
  }
  const raw =
    res.data !== undefined ? (typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2)) : "";
  const text = raw || "OK";
  return { content: [{ type: "text" as const, text: `${text}${warnings}` }] };
}
