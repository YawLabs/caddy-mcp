import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// file lives one level below the repo root in both layouts -- src/ under vitest,
// dist/ for the compiled node:test run -- so the same hop reaches the root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("release metadata", () => {
  // server.json is what the Official MCP Registry reads at publish time. It
  // carries the version twice (top-level + packages[].version) and release.sh
  // bumps it separately from package.json. Without this, an edit that updates
  // one but not the other ships a desynced registry entry -- and the failure
  // only surfaces to users, never to the release.
  //
  // Ported from tailscale-mcp, which was the only server that had it. It earned
  // its keep immediately: it caught a version skew during the 0.15.0 release
  // that every other repo would have published silently.
  it("server.json top-level version matches package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    expect(
      server.version,
      `server.json version (${String(server.version)}) must match package.json version (${String(pkg.version)})`,
    ).toBe(pkg.version);
  });

  it("server.json packages[].version all match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    const packages = server.packages as Array<{ version: string; identifier?: string }> | undefined;
    expect(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package").toBe(true);
    for (const entry of packages ?? []) {
      expect(
        entry.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) must match package.json version (${String(pkg.version)})`,
      ).toBe(pkg.version);
    }
  });

  it("mcpName in package.json matches server.json name", () => {
    // A different drift mode: the registry keys the package by `name`, the npm
    // consumer reads `mcpName`. Disagreement puts discovery and install on
    // different identifiers.
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    // Both must be present, or the equality below passes vacuously when a
    // refactor drops both fields.
    expect(
      typeof pkg.mcpName === "string" && (pkg.mcpName as string).length > 0,
      "package.json must declare a non-empty `mcpName`",
    ).toBe(true);
    expect(
      typeof server.name === "string" && (server.name as string).length > 0,
      "server.json must declare a non-empty `name`",
    ).toBe(true);
    expect(pkg.mcpName, "package.json mcpName must equal server.json name").toBe(server.name);
  });
});
