import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * launcher takes the override verbatim after an existsSync check, so a shell
 * script can stand in for the runtime and behave however a case needs.
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
 */
function runLauncher(
  args: string[],
  env: Record<string, string>,
  onStderr?: (chunk: string, child: ReturnType<typeof spawn>) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { ...process.env, ...env },
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

// The launcher's node path imports dist/index.js, so it needs a build. Mirrors
// the gating the other suites use for the built CLI.
describe.skipIf(!existsSync(DIST_CLI))("launcher: runtime selection", () => {
  it("CADDY_MCP_RUNTIME=node runs the server in-process and reports the version", async () => {
    const res = await runLauncher(["--version"], { CADDY_MCP_RUNTIME: "node" });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
  }, 30000);

  it("auto falls back to Node when OAM_BIN points at nothing", async () => {
    // The silent-fallback contract: a bad override must not be fatal in auto
    // mode, or a stale OAM_BIN in a host config would break every launch.
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "auto",
      OAM_BIN: MISSING_OAM,
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
  }, 30000);

  it("CADDY_MCP_RUNTIME=oam fails loudly when no oam binary exists", async () => {
    // The counterpart: explicitly demanding oam is a real misconfiguration, so
    // it must exit non-zero rather than quietly running a different runtime
    // than the operator asked for.
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "oam",
      OAM_BIN: MISSING_OAM,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no runnable oam binary was found");
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

/**
 * Signal forwarding and escalation.
 *
 * POSIX only, deliberately: there are no POSIX signals on Windows, where
 * `child.kill(sig)` ignores the name and calls TerminateProcess. The launcher
 * therefore forwards nothing there and relies on the console delivering Ctrl-C
 * to the whole process group -- behavior this harness cannot drive.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: signal handling", () => {
  /**
   * Answering `--version` is MANDATORY for any stand-in oam.
   *
   * Before spawning, the launcher runs a synchronous `execFileSync(oam,
   * ["--version"])` and requires >= OAM_MIN (0.9.0). A fake that ignores the
   * probe does not merely fail the gate -- if it blocks, execFileSync blocks
   * the launcher forever, and if it answers unparseably the launcher silently
   * falls back to Node, so the test would measure the fallback path while
   * appearing to exercise signal forwarding.
   */
  const VERSION_PROBE = ['if [ "$1" = "--version" ]; then echo "oam 0.9.0"; exit 0; fi'];

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

  function writeFake(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "caddy-mcp-fake-oam-"));
    const file = join(dir, "oam");
    writeFileSync(file, body, "utf-8");
    chmodSync(file, 0o755);
    return file;
  }

  /** A stand-in oam that either shuts down cleanly on a signal or ignores it. */
  function fakeOam(kind: "graceful" | "wedged"): string {
    return writeFake(kind === "graceful" ? GRACEFUL : WEDGED);
  }

  it("rejects an oam older than the supported floor", async () => {
    // The version gate is the first subprocess the launcher runs, and it has to
    // tell "too old" apart from "unreadable" -- they have different remedies.
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "oam",
      OAM_BIN: writeFake(TOO_OLD),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("0.8.9");
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
    // Well inside the 2s escalation window -- the child's own exit ended this.
    expect(res.ms).toBeLessThan(6000);
  }, 30000);

  it("escalates on a wedged child instead of hanging forever", async () => {
    // The regression this guards: forwarding used to be gated on `child.killed`,
    // which records only that kill() was CALLED, never that the child is gone.
    // A child that ignored the signal left the launcher waiting with no escape
    // hatch -- verified against the pre-fix launcher, which hung indefinitely.
    const res = await runWithSignals(fakeOam("wedged"), 1);
    expect(res.code).toBe(130); // 128 + SIGINT
    expect(res.ms).toBeGreaterThan(1200); // the grace window was actually honored
    expect(res.ms).toBeLessThan(8000);
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
