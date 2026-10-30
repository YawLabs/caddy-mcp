import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Tests for scripts/runtime.mjs, shared by scripts/typecheck.mjs (`npm run
 * typecheck`) and scripts/build-binary-oam.mjs. Its oam probe has to agree with
 * the launcher's (bin/caddy-mcp.mjs), which reads the same variables and probes
 * the same binaries.
 *
 * Like launcher.test.ts, runtime.mjs is exercised as a SUBPROCESS rather than
 * imported: it is a .mjs outside src/, so importing it from a .ts test fails
 * `tsc` (no declaration file, and it is outside rootDir). Spawning also keeps
 * the env mutation inside the child.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = join(REPO_ROOT, "scripts", "runtime.mjs");

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

/** Run a probe script that imports the REAL scripts/runtime.mjs and prints one JSON line. */
function probe(body: string, nodeArgs: string[] = []): unknown {
  const dir = mkTemp("caddy-mcp-runtime-probe-");
  const file = join(dir, "probe.mjs");
  const importLine = `import { findOam } from ${JSON.stringify(`file://${RUNTIME.replace(/\\/g, "/")}`)};`;
  writeFileSync(file, `${importLine}\n${body}`);
  const res = spawnSync(process.execPath, [...nodeArgs, file], {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: 60_000,
  });
  const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * `OAM_BIN` is the Node running the test, and a `--import` preload (the same
 * trick as launcher.test.ts's runOnHost) makes runtime.mjs's `--version` probe
 * of it answer "oam 0.18.0": a runnable binary that identifies as oam, on every
 * platform. Without the preload it answers `v22.x.y` -- runs, but is not oam.
 */
const POSE_AS_OAM = [
  "--import",
  `data:text/javascript,${encodeURIComponent(
    [
      'import poseCp from "node:child_process";',
      'import { syncBuiltinESMExports as poseSync } from "node:module";',
      "const poseReal = poseCp.execFileSync;",
      "poseCp.execFileSync = function (cmd, args, opts) {",
      `  if (cmd === ${JSON.stringify(process.execPath)} && args?.[0] === "--version") return "oam 0.18.0\\n";`,
      "  return poseReal.call(this, cmd, args, opts);",
      "};",
      "poseSync();",
    ].join("\n"),
  )}`,
];

/**
 * Isolation: OAM_BIN is the only discoverable candidate (HOME, LOCALAPPDATA and
 * PATH are an empty temp dir, so a real oam on this box cannot answer).
 * `call` is the findOam invocation, so the `require: true` form can be driven
 * too; a throw prints `{ error }`.
 */
function probeWith(runtime: string, nodeArgs: string[] = POSE_AS_OAM, call = "findOam()"): unknown {
  return probe(
    `process.env.OAM_BIN = ${JSON.stringify(process.execPath)};
process.env.CADDY_MCP_RUNTIME = ${JSON.stringify(runtime)};
process.env.HOME = ${JSON.stringify(mkTemp("caddy-mcp-rt-home-"))};
process.env.USERPROFILE = process.env.HOME;
process.env.LOCALAPPDATA = process.env.HOME;
process.env.PATH = process.env.HOME;
let out;
try { out = ${call}; } catch (e) { out = { error: String(e?.message ?? e) }; }
process.stdout.write(JSON.stringify(out));`,
    nodeArgs,
  );
}

describe("scripts/runtime.mjs: CADDY_MCP_RUNTIME=node skips discovery", () => {
  it("finds the OAM_BIN that answers with oam's banner when no runtime is forced (guards the cases below)", () => {
    // Without this control, the assertions below could pass because OAM_BIN was
    // never accepted, not because discovery was skipped.
    expect(probeWith("")).toEqual({ cmd: process.execPath, version: "oam 0.18.0", fromBuildTree: false });
  });

  it("returns null without probing when the value is a non-lowercase 'node'", () => {
    // The launcher lowercases CADDY_MCP_RUNTIME, so `=NODE` forces Node there;
    // an exact compare here would silently typecheck on oam instead.
    expect(probeWith("NODE")).toBeNull();
  });

  it("returns null without probing for a padded 'node ' too", () => {
    // cmd.exe's `set CADDY_MCP_RUNTIME=node && ...` keeps the space; the
    // launcher trims it, so this must as well.
    expect(probeWith("node ")).toBeNull();
  });

  it("throws under require: true for a non-lowercase 'node' too", () => {
    expect(probeWith("Node", POSE_AS_OAM, "findOam({ require: true })")).toEqual({
      error: expect.stringContaining("CADDY_MCP_RUNTIME=node conflicts"),
    });
  });
});

/**
 * Answering `--version` is not enough: node prints "v22.x.y", and accepting it
 * would make `npm run typecheck` run `node check .` and fail instead of falling
 * back to tsc, and the binary build try to compile with node. findOam requires
 * oam's banner, as the launcher's oamBanner does.
 */
describe("scripts/runtime.mjs: a non-oam OAM_BIN", () => {
  it("skips a binary that runs but does not identify as oam", () => {
    // The real node, unposed, as the only candidate.
    expect(probeWith("", [])).toBeNull();
  });

  it("is no oam at all under require: true", () => {
    expect(probeWith("", [], "findOam({ require: true })")).toEqual({
      error: expect.stringContaining("no working oam was found"),
    });
  });
});

/**
 * A wedged oam on PATH must not hang `npm run typecheck` or the binary build:
 * the probe is bounded like the launcher's. Extracted from the real source (as
 * launcher.test.ts does for runtimePlan) rather than timed with a sleeping
 * binary -- a shell-sleep fixture is POSIX-only and would not run on Windows,
 * and a fake that cannot be spawned returns null without exercising the bound.
 */
describe("scripts/runtime.mjs: the oam probe is bounded", () => {
  const SOURCE = readFileSync(RUNTIME, "utf-8");

  it("passes a timeout to the oam --version probe", () => {
    const probeFn = SOURCE.match(/export function findOam\([^)]*\) \{[\s\S]*?\n\}/)?.[0];
    expect(probeFn, "could not extract findOam() from scripts/runtime.mjs").toBeDefined();
    const call = probeFn?.match(/execFileSync\([\s\S]*?\);/)?.[0];
    expect(call, "findOam has no execFileSync call").toBeDefined();
    expect(call).toMatch(/timeout:\s*VERSION_PROBE_TIMEOUT_MS/);
  });

  it("defines that bound as a positive number of milliseconds", () => {
    const m = SOURCE.match(/const VERSION_PROBE_TIMEOUT_MS = ([\d_]+);/);
    expect(m, "VERSION_PROBE_TIMEOUT_MS is not defined").not.toBeNull();
    const ms = Number((m?.[1] ?? "").replace(/_/g, ""));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});
