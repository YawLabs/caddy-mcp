import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

/**
 * Tests for bin/caddy-mcp.mjs -- the published `caddy-mcp` entry point.
 *
 * This is the most user-visible file in the package: every install runs it, and
 * a break here means "the server does not start" for everyone. It sits outside
 * both existing gates -- `npm run lint` scopes to `src/`, and nothing else
 * exercises `bin/` -- so a 200-line change to it previously landed with no
 * automated coverage at all.
 *
 * `OAM_BIN` is the seam that makes this testable without installing oam: the
 * launcher uses the override, before any discovery, once it answers
 * `--version` at or above the floor, so a shell script can stand in for the
 * runtime and behave however a case needs.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = join(REPO_ROOT, "bin", "caddy-mcp.mjs");
const DIST_CLI = join(REPO_ROOT, "dist", "index.js");
const MISSING_OAM = join(REPO_ROOT, "does-not-exist-oam-binary");

const isWin = process.platform === "win32";

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Run the launcher to completion. `onStderr` can fire a signal once the child
 * announces itself -- signalling before the child is up would test the wrong
 * thing.
 *
 * An `undefined` value REMOVES a variable. The child's env starts from
 * process.env, and Node's spawn skips keys whose value is undefined, so this is
 * how a case asserts "genuinely unset" instead of inheriting whatever the
 * machine running the suite happens to export.
 *
 * An override replaces the inherited key whatever its case. Windows env names
 * are case-insensitive but a spread of process.env keeps their spelling
 * (`Path`), so a plain `{ ...process.env, PATH }` would hand the child BOTH
 * keys and leave which one wins to the platform.
 *
 * `nodeArgs` go to the Node running the launcher, BEFORE the launcher path --
 * the slot a `--import` preload has to occupy.
 */
function runLauncher(
  args: string[],
  env: Record<string, string | undefined>,
  onStderr?: (chunk: string, child: ReturnType<typeof spawn>) => void,
  nodeArgs: string[] = [],
): Promise<RunResult> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
  }
  Object.assign(merged, env);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, LAUNCHER, ...args], {
      env: merged,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      onStderr?.(s, child);
    });
    // "exit", not "close". `close` waits for every writer on the inherited
    // stdio to let go, and the launcher passes stdio:"inherit" to its child --
    // so a grandchild that outlives the child (a shell's `sleep`, say) holds
    // the pipe open and `close` never fires, hanging the test on a launcher
    // that already exited correctly. Drain briefly so trailing output written
    // just before exit is still captured.
    child.on("exit", (code, signal) => {
      const ms = Date.now() - started;
      setTimeout(() => resolve({ code, signal, stdout, stderr, ms }), 150);
    });
  });
}

/**
 * An environment with no oam anywhere discovery looks: HOME, USERPROFILE and
 * LOCALAPPDATA point at a fresh empty directory, so the installed locations are
 * empty, and PATH holds only the directory of the Node running this test. Keeps
 * a real oam on the developer's box out of reach -- discovery now asks every
 * binary it can see, so an OAM_BIN that is passed over no longer shields a case
 * from one. The launcher's own variables are cleared too; `extra` wins.
 */
function isolated(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const empty = mkdtempSync(join(tmpdir(), "caddy-mcp-launcher-home-"));
  return {
    PATH: dirname(process.execPath),
    HOME: empty,
    USERPROFILE: empty,
    LOCALAPPDATA: empty,
    OAM_BIN: undefined,
    CADDY_MCP_RUNTIME: undefined,
    CADDY_MCP_SANDBOX: undefined,
    ...extra,
  };
}

// The launcher's node path imports dist/index.js, so it needs a build. Mirrors
// the gating the other suites use for the built CLI.
describe.skipIf(!existsSync(DIST_CLI))("launcher: runtime selection", () => {
  it("CADDY_MCP_RUNTIME=node runs the server in-process and reports the version", async () => {
    const res = await runLauncher(["--version"], { CADDY_MCP_RUNTIME: "node" });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
  }, 30000);

  it("auto names an OAM_BIN that points at nothing, then falls back to Node", async () => {
    // A bad override must not be fatal in auto mode, or a stale OAM_BIN in a
    // host config would break every launch. It must not be SILENT either: a
    // typo in OAM_BIN used to mean Node with no hint why.
    const res = await runLauncher(["--version"], isolated({ CADDY_MCP_RUNTIME: "auto", OAM_BIN: MISSING_OAM }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    expect(res.stderr).toMatch(/^caddy-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  }, 30000);

  it("CADDY_MCP_RUNTIME=oam fails loudly when no oam binary exists", async () => {
    // The counterpart: explicitly demanding oam is a real misconfiguration, so
    // it must exit non-zero rather than quietly running a different runtime
    // than the operator asked for.
    const res = await runLauncher(["--version"], isolated({ CADDY_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }));
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no usable oam (0.15.2 or newer) was found");
    expect(res.stderr).toContain("does not exist");
    // This diagnostic precedes process.exit and is written synchronously. If
    // that ever regressed to an async write, the exit would truncate it away.
    expect(res.stderr).toContain("CADDY_MCP_RUNTIME=node");
  }, 30000);

  it("speaks MCP over stdio through the launcher", async () => {
    // The assertion the version cases cannot make: the published entry point
    // yields a working MCP server, not just a version string.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      env: { ...process.env, CADDY_MCP_RUNTIME: "node" } as Record<string, string>,
    });
    const client = new Client({ name: "launcher-smoke", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("caddy-mcp");
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30000);
});

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/caddy-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

/** The REAL `pickNewest`, extracted the same way, with the floor it closes over. */
function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

// Pure logic over the launcher's source text: no build needed, so no skipIf.
describe("launcher: runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/caddy-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: false }), `mode=${mode} hostOam=${hostOam}`).toBe("in-process");
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- a security downgrade that no other symptom would reveal.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "0.15.2", "1.0.0", "0.9.0"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: true }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must not serve. Serving there was the bug: an oam
    // older than 0.9.0 cannot even hand stdio to a child with 'inherit', and
    // anything older than the latest release is not what the server is verified
    // on. "discover" is where it looks for a newer oam, then hands off to Node.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: false }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: false }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("runs CADDY_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    // The sandbox changes nothing here: node mode ignores it entirely.
    for (const sandbox of [false, true]) {
      expect(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), `sandbox=${sandbox}`).toBe("in-process");
      for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
        expect(runtimePlan({ mode: "node", hostOam, sandbox }), `hostOam=${hostOam} sandbox=${sandbox}`).toBe(
          "handoff-node",
        );
      }
    }
  });
});

describe("launcher: pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    expect(floor).toEqual([0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    expect(chosen?.path).toBe("path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    expect(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path).toBe("b");
    expect(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path).toBe("first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    expect(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path).toBe("good");
    expect(pickNewest([at("old", [0, 15, 1]), at("broken", null)])).toBeNull();
    expect(pickNewest([])).toBeNull();
  });
});

/**
 * Run the REAL bin under Node posing as oam, by preloading a
 * `process.versions.oam` key, or as plain Node when `hostOam` is undefined.
 *
 * The runtimePlan() cases above prove the decision; these prove the launcher
 * WIRES it -- that the call site actually reads `process.versions.oam` and the
 * sandbox grant list -- which no amount of testing runtimePlan in isolation
 * can. A real oam cannot be assumed on every box this suite runs on, and the
 * preload changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam, and cross-platform where the bash
 * fakes below are not. In-process, `--version` reaches dist/index.js and
 * prints `caddy-mcp <version>` with exit 0. On the discovery path, OAM_BIN is
 * that pinned Node, `node --version` clears the floor, and the launcher
 * spawns `node [flags] run <entry>` -- which has no `run` subcommand, prints no
 * version and exits non-zero. A usable OAM_BIN is taken before discovery runs,
 * so a real oam installed on the developer's box is never reached either.
 *
 * Every run also reports, at exit, what the LAUNCHER process's argv[1] ended up
 * as: runInProcess points it at dist/index.js, a handoff leaves it on the
 * launcher. That is the only way to tell "served in-process" from "handed off
 * to a child that printed the same version".
 *
 * CADDY_MCP_RUNTIME and CADDY_MCP_SANDBOX are REMOVED before `extraEnv`
 * applies, so a value exported by the developer's shell cannot change what is
 * being asserted.
 *
 * `extraPreload` is appended to the preload module, for a case that has to
 * change something else inside the launcher process before it runs.
 */
function runOnHost(
  hostOam: string | undefined,
  extraEnv: Record<string, string | undefined> = {},
  extraPreload = "",
): Promise<RunResult> {
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}\n${extraPreload}`)}`];
  return runLauncher(
    ["--version"],
    { OAM_BIN: process.execPath, CADDY_MCP_RUNTIME: undefined, CADDY_MCP_SANDBOX: undefined, ...extraEnv },
    undefined,
    preload,
  );
}

const IN_PROCESS_MARKER = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const HANDED_OFF_MARKER = /LAUNCHER_ARGV1=.*caddy-mcp\.mjs/;
const servedVersion = (run: RunResult) => run.code === 0 && /^caddy-mcp \d+\.\d+\.\d+/.test(run.stdout.trim());

// The in-process path imports dist/index.js, so it needs a build, like the
// runtime-selection block above.
describe.skipIf(!existsSync(DIST_CLI))("launcher: on an oam host", () => {
  // Each case boots one to three Node processes (launcher, the `--version`
  // probe, the spawned child), which outruns the suite's 30s default on a
  // contended Windows box.
  const TIMEOUT_MS = 45000;

  it(
    "control: on plain Node the launcher still discovers and spawns",
    async () => {
      // Without this, the in-process cases below would also pass for a launcher
      // that ALWAYS runs in-process and never uses oam at all.
      const run = await runOnHost(undefined);
      expect(servedVersion(run), `expected a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "serves in-process instead of spawning a nested oam",
    async () => {
      const envs: Record<string, string>[] = [{}, { CADDY_MCP_RUNTIME: "oam" }];
      for (const extraEnv of envs) {
        const run = await runOnHost("0.15.2", extraEnv);
        expect(servedVersion(run), `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`).toBe(true);
        expect(run.stderr).toMatch(IN_PROCESS_MARKER);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "still spawns under CADDY_MCP_SANDBOX=1, so --permission is not dropped",
    async () => {
      const run = await runOnHost("0.15.2", { CADDY_MCP_SANDBOX: "1" });
      expect(servedVersion(run), `the sandbox must force a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      // A spawned child failing, not the launcher diagnosing: every launcher
      // message starts with `caddy-mcp: `.
      expect(run.stderr).not.toMatch(/^caddy-mcp: /m);
    },
    TIMEOUT_MS,
  );

  it(
    "still discovers when the host oam is below the floor",
    async () => {
      // 0.15.1: the release just below the floor.
      const run = await runOnHost("0.15.1");
      expect(servedVersion(run), `a below-floor host must not shortcut, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      expect(run.stderr).not.toMatch(/^caddy-mcp: /m);
    },
    TIMEOUT_MS,
  );
});

/**
 * Nothing usable to spawn. The launcher must still serve -- on the right
 * runtime -- or refuse loudly, and never serve on an oam below the floor.
 */
describe.skipIf(!existsSync(DIST_CLI))("launcher: with no usable oam", () => {
  const TIMEOUT_MS = 45000;

  it(
    "hands a below-floor oam host off to Node rather than serving on it",
    async () => {
      const run = await runOnHost("0.9.0", isolated({ OAM_BIN: MISSING_OAM }));
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
      );
      // Served by the child, not in the launcher process.
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses to serve on a below-floor oam host when there is no Node either",
    async () => {
      const noNode = mkdtempSync(join(tmpdir(), "caddy-mcp-launcher-nopath-"));
      const run = await runOnHost("0.9.0", isolated({ PATH: noNode, OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(/no Node was found on PATH/);
    },
    TIMEOUT_MS,
  );

  it(
    "hands CADDY_MCP_RUNTIME=node off to Node even on a supported oam host, sandbox or not",
    async () => {
      for (const sandbox of [undefined, "1"]) {
        const run = await runOnHost("0.15.2", isolated({ CADDY_MCP_RUNTIME: "node", CADDY_MCP_SANDBOX: sandbox }));
        expect(servedVersion(run), `sandbox=${sandbox} -> ${JSON.stringify(run)}`).toBe(true);
        expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "serves a sandbox miss on a supported oam host in-process, and says where",
    async () => {
      // This repo's one departure from "else Node": the sandbox is the only
      // reason a supported oam host spawns at all, and the host IS a supported
      // oam, so a miss serves on it -- unsandboxed, as the header documents --
      // rather than moving to Node.
      const run = await runOnHost("0.15.2", isolated({ CADDY_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(IN_PROCESS_MARKER);
      expect(run.stderr).toMatch(
        /^caddy-mcp: OAM_BIN=.*does not exist; serving in this process \(oam 0\.15\.2\) instead\.$/m,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "hands a sandbox miss on a below-floor oam host off to Node, never serving on it",
    async () => {
      const run = await runOnHost("0.9.0", isolated({ CADDY_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      expect(run.stderr).toMatch(/does not exist; using Node instead\./);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses a sandbox miss under CADDY_MCP_RUNTIME=oam, even on a supported oam host",
    async () => {
      const run = await runOnHost(
        "0.15.2",
        isolated({ CADDY_MCP_SANDBOX: "1", CADDY_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }),
      );
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("no usable oam (0.15.2 or newer) was found");
    },
    TIMEOUT_MS,
  );
});

/**
 * The chosen oam passed its `--version` probe and then could not be spawned
 * (deleted or replaced in between), on an oam host.
 *
 * An oam host pipes stdio and mirrors the child on 'close'. A failed spawn
 * emits 'error' and THEN 'close' with the negative errno, so a close handler
 * that does not wait for 'spawn' exits the launcher in the middle of the
 * fallback 'error' just started, and nothing serves. A Node host listens for
 * 'exit' instead, which a failed spawn never emits -- which is why the POSIX
 * "spawn failure fallback" block below could not catch this.
 *
 * The preload makes the FIRST spawn target a path that does not exist; any
 * later spawn (the Node handoff) runs normally. Cross-platform: no bash fake.
 */
describe.skipIf(!existsSync(DIST_CLI))("launcher: failed spawn on an oam host", () => {
  const TIMEOUT_MS = 45000;
  const FAIL_FIRST_SPAWN = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const realSpawn = childProcess.spawn;",
    "let failed = false;",
    "childProcess.spawn = function (cmd, args, opts) {",
    "  if (failed) return realSpawn.call(this, cmd, args, opts);",
    "  failed = true;",
    '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");

  it(
    "still hands a below-floor host off to Node",
    async () => {
      const run = await runOnHost("0.9.0", isolated({ OAM_BIN: process.execPath }), FAIL_FIRST_SPAWN);
      expect(servedVersion(run), `the Node fallback must still serve, got ${JSON.stringify(run)}`).toBe(true);
      expect(run.stderr).toMatch(/^caddy-mcp: failed to launch oam at .*; using Node instead\.$/m);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on /,
      );
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
    },
    TIMEOUT_MS,
  );

  it(
    "still serves a sandbox request in-process on a supported host",
    async () => {
      const run = await runOnHost(
        "0.15.2",
        isolated({ OAM_BIN: process.execPath, CADDY_MCP_SANDBOX: "1" }),
        FAIL_FIRST_SPAWN,
      );
      expect(servedVersion(run), `the in-process fallback must still serve, got ${JSON.stringify(run)}`).toBe(true);
      expect(run.stderr).toMatch(
        /^caddy-mcp: failed to launch oam at .*; serving in this process \(oam 0\.15\.2\) instead\.$/m,
      );
      expect(run.stderr).toMatch(IN_PROCESS_MARKER);
    },
    TIMEOUT_MS,
  );

  it(
    "exits 1 under CADDY_MCP_RUNTIME=oam instead of falling back",
    async () => {
      const run = await runOnHost(
        "0.9.0",
        isolated({ OAM_BIN: process.execPath, CADDY_MCP_RUNTIME: "oam" }),
        FAIL_FIRST_SPAWN,
      );
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^caddy-mcp: failed to launch oam at /m);
      expect(run.stderr).not.toMatch(/running on /);
    },
    TIMEOUT_MS,
  );
});

/**
 * Answering `--version` is MANDATORY for any stand-in oam.
 *
 * Before spawning, the launcher runs a synchronous `execFileSync(oam,
 * ["--version"])` and requires >= OAM_MIN (0.15.2). A fake that ignores the
 * probe does not merely fail the gate -- if it wedges, the launcher waits out
 * the probe's 5s bound, and if it answers unparseably the launcher passes it
 * over and falls back to Node, so the test would measure the fallback path
 * while appearing to exercise the oam one.
 *
 * Shared by the POSIX-gated blocks below. The fakes are bash scripts, which is
 * also why those blocks skip on Windows: Node cannot spawn a .cmd/.bat without
 * `shell: true`, the same constraint that keeps the launcher's own discovery to
 * `.exe`.
 */
const VERSION_PROBE = ['if [ "$1" = "--version" ]; then echo "oam 0.15.2"; exit 0; fi'];

/** Write an executable stand-in oam into `dir` (a fresh temp dir by default); returns its path. */
function writeFake(body: string, dir = mkdtempSync(join(tmpdir(), "caddy-mcp-fake-oam-"))): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "oam");
  writeFileSync(file, body, "utf-8");
  chmodSync(file, 0o755);
  return file;
}

/**
 * Signal forwarding and escalation.
 *
 * POSIX only, deliberately: there are no POSIX signals on Windows, where
 * `child.kill(sig)` ignores the name and calls TerminateProcess. The launcher
 * therefore forwards nothing there and relies on the console delivering Ctrl-C
 * to the whole process group -- behavior this harness cannot drive.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: signal handling", () => {
  const GRACEFUL = [
    "#!/bin/bash",
    ...VERSION_PROBE,
    'cleanup() { echo "CHILD: cleanup ran" >&2; exit 0; }',
    "trap cleanup TERM INT",
    'echo "CHILD: up" >&2',
    "while true; do sleep 0.05; done",
    "",
  ].join("\n");

  const WEDGED = [
    "#!/bin/bash",
    ...VERSION_PROBE,
    "trap '' TERM INT",
    'echo "CHILD: up" >&2',
    "while true; do sleep 0.05; done",
    "",
  ].join("\n");

  /** An oam that satisfies discovery but is older than the launcher's floor. */
  const TOO_OLD = ["#!/bin/bash", 'echo "oam 0.8.9"', "exit 0", ""].join("\n");

  /** A stand-in oam that either shuts down cleanly on a signal or ignores it. */
  function fakeOam(kind: "graceful" | "wedged"): string {
    return writeFake(kind === "graceful" ? GRACEFUL : WEDGED);
  }

  it("rejects an oam older than the supported floor", async () => {
    // The version gate is the first subprocess the launcher runs, and it has to
    // tell "too old" apart from "unreadable" -- they have different remedies.
    // Isolated: a real oam elsewhere on the box would otherwise satisfy `oam`.
    const res = await runLauncher(["--version"], isolated({ CADDY_MCP_RUNTIME: "oam", OAM_BIN: writeFake(TOO_OLD) }));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("is oam 0.8.9, older than 0.15.2");
  }, 30000);

  /** Signal the launcher `count` times, starting once the child is up. */
  function runWithSignals(oam: string, count: number) {
    let fired = false;
    return runLauncher([], { OAM_BIN: oam, CADDY_MCP_RUNTIME: "oam" }, (chunk, child) => {
      if (fired || !chunk.includes("CHILD: up")) return;
      fired = true;
      for (let i = 0; i < count; i++) {
        setTimeout(() => child.kill("SIGINT"), i * 120);
      }
    });
  }

  it("lets a graceful child run its own shutdown", async () => {
    const res = await runWithSignals(fakeOam("graceful"), 1);
    expect(res.stderr).toContain("CHILD: cleanup ran");
    expect(res.code).toBe(0);
    // Must stay well BELOW ESCALATE_AFTER_MS (5s): that is what proves the
    // child's own exit ended this rather than the escalation timer firing.
    expect(res.ms).toBeLessThan(3000);
  }, 30000);

  it("escalates on a wedged child instead of hanging forever", async () => {
    // The regression this guards: forwarding used to be gated on `child.killed`,
    // which records only that kill() was CALLED, never that the child is gone.
    // A child that ignored the signal left the launcher waiting with no escape
    // hatch -- verified against the pre-fix launcher, which hung indefinitely.
    const res = await runWithSignals(fakeOam("wedged"), 1);
    expect(res.code).toBe(130); // 128 + SIGINT
    expect(res.ms).toBeGreaterThan(4000); // the full 5s grace window was honored
    expect(res.ms).toBeLessThan(12000);
  }, 30000);

  it("does not hard-kill a graceful child when signals repeat", async () => {
    // Escalation is armed by a timer, not by counting signals: a supervisor
    // sends SIGINT then SIGTERM milliseconds apart, and a process-group Ctrl-C
    // delivers its own copy, so a repeat signal is not impatience.
    const res = await runWithSignals(fakeOam("graceful"), 3);
    expect(res.stderr).toContain("CHILD: cleanup ran");
    expect(res.code).toBe(0);
  }, 30000);
});

/**
 * `CADDY_MCP_SANDBOX=1` grant derivation.
 *
 * sandboxFlags() is module-scope inside an executable script, so there is
 * nothing to import: the seam is the same stand-in oam the block above uses,
 * told to echo the argv it was handed. That argv IS the contract -- every grant
 * fails CLOSED, so a wrong one shows up as a connection error or a feature that
 * quietly does nothing, never as a complaint from the launcher.
 *
 * POSIX only for the same reason as the signal block: the fake is a bash script.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: sandbox grants", () => {
  /** A stand-in oam that reports the argv it was given, one entry per line. */
  const ECHO_ARGV = ["#!/bin/bash", ...VERSION_PROBE, 'for a in "$@"; do echo "ARGV: $a" >&2; done', "exit 0", ""].join(
    "\n",
  );

  /**
   * The argv the launcher handed oam, in order.
   *
   * CADDY_MCP_RUNTIME=oam so a fake that somehow fails discovery is a loud
   * failure rather than a silent fallback to Node, which would report no flags
   * at all and pass every "did not grant X" assertion for the wrong reason.
   * The two derived variables are cleared first: the suite must not read
   * differently on a machine that exports its own CADDY_ADMIN_URL.
   */
  async function argvFor(env: Record<string, string | undefined>): Promise<string[]> {
    const res = await runLauncher([], {
      OAM_BIN: writeFake(ECHO_ARGV),
      CADDY_MCP_RUNTIME: "oam",
      CADDY_MCP_SANDBOX: "1",
      CADDY_ADMIN_URL: undefined,
      CADDY_MCP_SNAPSHOT_DIR: undefined,
      ...env,
    });
    expect(res.code, res.stderr).toBe(0);
    return res.stderr
      .split("\n")
      .filter((line) => line.startsWith("ARGV: "))
      .map((line) => line.slice("ARGV: ".length));
  }

  /** The value of a single `--flag=value` grant, or undefined when absent. */
  function grant(argv: string[], flag: string): string | undefined {
    return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  }

  it("grants the endpoint api.ts actually dials", async () => {
    const argv = await argvFor({});
    // src/api.ts declares DEFAULT_URL = "http://localhost:2019". The grant and
    // the dial are matched as TEXT, so a launcher defaulting to 127.0.0.1 while
    // the server dials localhost denies every request out of the box -- with
    // both files reading correctly on their own.
    expect(grant(argv, "--allow-net")).toBe("localhost");
    // Process-level flags belong BEFORE the subcommand: `oam run --permission`
    // is rejected outright.
    expect(argv.indexOf("--permission")).toBe(0);
    expect(argv[argv.indexOf("run") + 1]).toBe(DIST_CLI);
  }, 30000);

  it("derives the grant from CADDY_ADMIN_URL, host only", async () => {
    const argv = await argvFor({ CADDY_ADMIN_URL: "http://caddy.internal:9000" });
    // Host WITHOUT the port. oam presents the bare hostname to the net check for
    // `fetch` and "host:port" only for sockets, and grants are prefix-matched --
    // "caddy.internal" does not start with "caddy.internal:9000", so pinning the
    // port denies every request api.ts makes over TCP.
    expect(grant(argv, "--allow-net")).toBe("caddy.internal");
  }, 30000);

  for (const [label, value] of [
    ["empty", ""],
    ["whitespace-only", "   "],
  ]) {
    it(`treats an ${label} CADDY_ADMIN_URL as unset, not as "grant everything"`, async () => {
      const argv = await argvFor({ CADDY_ADMIN_URL: value });
      expect(grant(argv, "--allow-net")).toBe("localhost");
      // The regression: `??` keeps "" (only null/undefined fall through), the
      // URL parse is skipped, and the BARE --allow-net grants every host on the
      // network -- a sandbox switched on and silently doing nothing. api.ts
      // reads the same variable with `||`, so "" already means "use the
      // default" there; the launcher has to agree.
      expect(argv).not.toContain("--allow-net");
    }, 30000);
  }

  for (const [label, value] of [
    ["URL form", "unix:///var/run/caddy-admin.sock"],
    ["Caddy network-address form", "unix//var/run/caddy-admin.sock"],
    // The MALFORMED spellings matter as much as the tidy two, and for a
    // counter-intuitive reason: each one parses (or throws) into an empty
    // hostname, so a check matching only the well-formed pair would hand these
    // the BARE --allow-net -- the widest possible grant, for input that plainly
    // meant a socket. src/api.ts fails all of them up front in
    // getMalformedUnixUrl, so denying the net category costs nothing.
    ["single slash after unix:", "unix:/run/caddy-admin.sock"],
    ["relative path", "unix://relative.sock"],
    ["bare scheme", "unix://"],
    // getUnixSocketPath is case-SENSITIVE and rejects this, but
    // getMalformedUnixUrl's /^unix[:/]/i accepts it -- so the launcher has to
    // follow the case-insensitive one or uppercase falls through to wide open.
    ["uppercase scheme", "UNIX:///var/run/caddy-admin.sock"],
  ]) {
    it(`emits NO net grant for a unix-socket CADDY_ADMIN_URL (${label})`, async () => {
      const argv = await argvFor({ CADDY_ADMIN_URL: value });
      // The same wide-open shape the empty-string case above guards, reached by
      // a different route: `new URL("unix:///...").hostname` is "" (and the
      // Caddy spelling throws outright), so the host check fell through and left
      // the BARE --allow-net -- every host on the network, handed out for the
      // MOST hardened admin config Caddy recommends.
      //
      // An OMITTED --allow-net is what denies the category (oam reads absent as
      // false, bare as "*"), so assert absence, not a narrower value.
      expect(argv.filter((a) => a.startsWith("--allow-net"))).toEqual([]);
      // The sandbox must still be on -- absence of the flag has to mean "denied",
      // not "we never got as far as building flags".
      expect(argv).toContain("--permission");
    }, 30000);
  }

  it("does not mistake a TCP host merely starting with 'unix' for a socket", async () => {
    // The false positive the unix check has to avoid; src/api.ts guards the same
    // case in getMalformedUnixUrl by matching "unix:" / "unix/" rather than a
    // bare "unix" prefix.
    const argv = await argvFor({ CADDY_ADMIN_URL: "http://unix.example.com:2019" });
    expect(grant(argv, "--allow-net")).toBe("unix.example.com");
  }, 30000);

  it("grants every environment variable the shipped bundle reads", async () => {
    const argv = await argvFor({});
    // Keep in step with `grep -rn process.env src/` outside src/tests.
    expect(grant(argv, "--allow-env")?.split(",")).toEqual([
      "CADDY_ADMIN_URL",
      "CADDY_API_TOKEN",
      "CADDY_LOAD_TIMEOUT",
      "CADDY_MAX_RETRIES",
      "CADDY_MCP_SNAPSHOT_DIR",
      "CADDY_TIMEOUT",
    ]);
    // CADDY_MCP_SNAPSHOT_DIR is the one that was missing. A denied variable is
    // ABSENT from process.env rather than throwing, so src/snapshots.ts read it
    // as "not configured": caddy_revert degraded to memory-only and neither
    // process said anything.
  }, 30000);

  it("leaves the filesystem denied when snapshot persistence is off", async () => {
    const argv = await argvFor({});
    expect(argv.filter((a) => a.startsWith("--allow-fs"))).toEqual([]);
  }, 30000);

  it("grants exactly the snapshot directory when persistence is on", async () => {
    // A path, not a real directory: the grant is derived textually and the
    // launcher never stats it. An absolute path is already normalized, so the
    // two spellings collapse to one entry (see the relative case below).
    const dir = join(tmpdir(), "caddy-mcp-snapshots");
    const argv = await argvFor({ CADDY_MCP_SNAPSHOT_DIR: dir });
    // Read AND write: snapshots.ts writes each snapshot and reads the directory
    // back to rehydrate the ring on the next start. Granting the variable
    // without the directory only moves the silent failure -- persist() swallows
    // its own I/O errors and falls back to the in-memory ring.
    expect(grant(argv, "--allow-fs-read")).toBe(dir);
    expect(grant(argv, "--allow-fs-write")).toBe(dir);
  }, 30000);

  it("grants both spellings of a relative snapshot directory", async () => {
    // Grants are plain string PREFIXES matched against the path each call
    // passes. snapshots.ts hands the raw variable to readdirSync/mkdirSync but
    // builds per-file paths with path.join, which normalizes "./snaps" to
    // "snaps" -- so the raw form alone misses the files and the normalized form
    // alone misses the directory listing.
    const argv = await argvFor({ CADDY_MCP_SNAPSHOT_DIR: "./snaps" });
    expect(grant(argv, "--allow-fs-read")).toBe("./snaps,snaps");
    expect(grant(argv, "--allow-fs-write")).toBe("./snaps,snaps");
  }, 30000);

  it("emits no permission flags at all unless CADDY_MCP_SANDBOX=1", async () => {
    const argv = await argvFor({ CADDY_MCP_SANDBOX: undefined });
    expect(argv[0]).toBe("run");
    expect(argv.some((a) => a === "--permission" || a.startsWith("--allow-"))).toBe(false);
  }, 30000);
});

/**
 * Discovery asks EVERY oam it can see and takes the newest usable one.
 *
 * The pickNewest() unit tests prove the choice; these prove chooseOam WIRES it
 * -- that the installed location and PATH are both probed, and that a passed
 * over OAM_BIN hands on to discovery rather than ending it. HOME is a temp dir
 * holding a fake ~/.oam/bin/oam, and PATH puts a second fake first, ahead of
 * the Node directory.
 *
 * POSIX only for the same reason as the blocks above: the fakes are bash
 * scripts, and here they must also sit at the exact names discovery looks for.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: discovery", () => {
  /** A stand-in oam reporting `version` that, when run, names itself on stderr. */
  const fake = (version: string, label: string) =>
    [
      "#!/bin/bash",
      `if [ "$1" = "--version" ]; then echo "oam ${version}"; exit 0; fi`,
      `echo "CHILD: ${label}" >&2`,
      "exit 0",
      "",
    ].join("\n");

  /** An isolated env with a fake in ~/.oam/bin and another in a PATH dir. */
  function withInstalledAndPath(installed: string, onPath: string, extra: Record<string, string | undefined> = {}) {
    const env = isolated(extra);
    const home = env.HOME as string;
    writeFake(installed, join(home, ".oam", "bin"));
    const pathDir = mkdtempSync(join(tmpdir(), "caddy-mcp-fake-path-"));
    writeFake(onPath, pathDir);
    return { ...env, PATH: `${pathDir}${delimiter}${env.PATH}` };
  }

  it("spawns the newest usable oam, not the first one found", async () => {
    // The bug: the installed location is searched first, and discovery stopped
    // at the first binary that existed, so a stale installed copy hid a newer
    // one on PATH.
    const env = withInstalledAndPath(fake("0.15.2", "installed"), fake("0.16.0", "path"), {
      CADDY_MCP_RUNTIME: "oam",
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: path");
    expect(res.stderr).not.toContain("CHILD: installed");
  }, 30000);

  it("keeps the installed copy on a tie", async () => {
    const env = withInstalledAndPath(fake("0.15.2", "installed"), fake("0.15.2", "path"), {
      CADDY_MCP_RUNTIME: "oam",
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: installed");
    expect(res.stderr).not.toContain("CHILD: path");
  }, 30000);

  it("passes over a below-floor oam, installed or OAM_BIN, and says so", async () => {
    const env = withInstalledAndPath(fake("0.9.0", "installed"), fake("0.15.2", "path"), {
      OAM_BIN: writeFake(fake("0.8.9", "override")),
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: path");
    expect(res.stderr).not.toMatch(/CHILD: (installed|override)/);
    // The OAM_BIN note names the binary that was used instead.
    expect(res.stderr).toMatch(
      /^caddy-mcp: OAM_BIN=.* is oam 0\.8\.9, older than 0\.15\.2; using .*oam \(oam 0\.15\.2\)\.$/m,
    );
  }, 30000);
});

/**
 * The version gate's TWO causes, and the AUTO half of both.
 *
 * An unparseable `--version` and an old one are both passed over, but the
 * launcher deliberately splits their detail: a null version is not "old", and
 * telling that user to `oam self-update` sends them after the one cause it
 * definitely is not. These pin the header's promise that an unusable oam is
 * not an error under auto: the launcher falls back to Node and says so.
 *
 * Isolated, so no real oam can be discovered once the fake is passed over.
 * POSIX only for the same reason as the blocks above: the fakes are bash scripts.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: version gate fallback", () => {
  /** An oam that satisfies discovery but is older than the launcher's floor. */
  const TOO_OLD = ["#!/bin/bash", 'echo "oam 0.8.9"', "exit 0", ""].join("\n");

  /**
   * An oam that runs cleanly and answers with something the launcher's
   * `(\d+)\.(\d+)\.(\d+)` cannot read, so oamVersion returns null. Stands in for
   * the causes a test cannot construct portably -- wrong arch, a non-oam binary
   * on OAM_BIN, a file deleted between the stat and the probe.
   */
  const UNREADABLE = ["#!/bin/bash", 'echo "not a version"', "exit 0", ""].join("\n");

  it("falls back to Node when the oam it was given is too old", async () => {
    // CADDY_MCP_RUNTIME left unset by isolated(), not set to "auto": auto is the
    // default and the mode every install actually runs in, so the documented
    // fallback has to hold without the variable being present at all.
    const res = await runLauncher(["--version"], isolated({ OAM_BIN: writeFake(TOO_OLD) }));
    expect(res.code, res.stderr).toBe(0);
    // Exit 0 alone would also pass on a launcher that started nothing. The
    // version on stdout is what proves the Node fallback actually SERVED.
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    // Naming the version found is the point of the notice: a silent downgrade is
    // how someone keeps running an oam they meant to update.
    expect(res.stderr).toContain("0.8.9");
    expect(res.stderr).toContain("older than 0.15.2");
    expect(res.stderr).toContain("using Node instead");
  }, 30000);

  it("falls back to Node when oam does not report a readable version", async () => {
    const res = await runLauncher(
      ["--version"],
      isolated({ CADDY_MCP_RUNTIME: "auto", OAM_BIN: writeFake(UNREADABLE) }),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    // The other half of the split: this diagnostic must NOT claim a version it
    // never read, because "older than 0.15.2" would send the operator to
    // self-update a binary that never ran.
    expect(res.stderr).toContain("could not be run, or did not report a version");
    expect(res.stderr).not.toContain("older than");
    expect(res.stderr).toContain("using Node instead");
    expect(res.stderr).not.toContain("self-update");
  }, 30000);

  it("names the unreadable binary, not self-update, under CADDY_MCP_RUNTIME=oam", async () => {
    // The loud counterpart of the case above: exit 1, with the detail and the
    // generic remedy line.
    const res = await runLauncher(
      ["--version"],
      isolated({ CADDY_MCP_RUNTIME: "oam", OAM_BIN: writeFake(UNREADABLE) }),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not be run, or did not report a version this launcher understands");
    expect(res.stderr).toContain("Install or update from https://oamjs.org");
    // The regression that would matter: `oam self-update` cannot fix a binary
    // that never ran, so offering it costs the operator the real cause.
    expect(res.stderr).not.toContain("self-update");
  }, 30000);
});

/**
 * Spawn failure AFTER a passing version probe.
 *
 * The window the launcher's own comment names: discovery is stat-only and the
 * probe is a separate process, so an oam can satisfy both and still be
 * unexecutable a moment later. spawn reports that asynchronously via 'error',
 * never as a throw, and auto mode has to degrade to Node -- an escaping 'error'
 * would take the server down for every host whose oam went missing.
 *
 * The fake DELETES ITSELF during the probe, which is one of the causes that
 * comment lists. Deletion rather than chmod because a running bash holds its own
 * open fd (so the script finishes normally) while the launcher's next use of that
 * path fails with ENOENT, and unlink behaves the same on every filesystem the
 * suite might run on -- the exec bit does not.
 *
 * POSIX only, like the blocks above: the fake is a bash script.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: spawn failure fallback", () => {
  /**
   * Answers `--version` with a supported version, then vanishes. The "CHILD: up"
   * line is never reached: it exists so a spawn that unexpectedly SUCCEEDS is
   * visible as a failed assertion rather than passing for the wrong reason.
   */
  const VANISHING = ["#!/bin/bash", 'rm -f "$0"', ...VERSION_PROBE, 'echo "CHILD: up" >&2', "exit 0", ""].join("\n");

  it("falls back to Node when a version-passing oam cannot be spawned", async () => {
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "auto",
      OAM_BIN: writeFake(VANISHING),
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    // Proves the version came from the in-process fallback rather than from an
    // oam that turned out to be runnable after all.
    expect(res.stderr).not.toContain("CHILD: up");
  }, 30000);

  it("fails loudly on an unspawnable oam under CADDY_MCP_RUNTIME=oam", async () => {
    // Same failure, opposite contract: explicitly demanding oam must not quietly
    // run a different runtime than the operator asked for.
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "oam",
      OAM_BIN: writeFake(VANISHING),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed to launch oam");
    expect(res.stdout).toBe("");
  }, 30000);
});
