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
 *
 * An `undefined` value REMOVES a variable. The child's env starts from
 * process.env, and Node's spawn skips keys whose value is undefined, so this is
 * how a case asserts "genuinely unset" instead of inheriting whatever the
 * machine running the suite happens to export.
 */
function runLauncher(
  args: string[],
  env: Record<string, string | undefined>,
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
 * Answering `--version` is MANDATORY for any stand-in oam.
 *
 * Before spawning, the launcher runs a synchronous `execFileSync(oam,
 * ["--version"])` and requires >= OAM_MIN (0.9.0). A fake that ignores the
 * probe does not merely fail the gate -- if it blocks, execFileSync blocks the
 * launcher forever, and if it answers unparseably the launcher silently falls
 * back to Node, so the test would measure the fallback path while appearing to
 * exercise the oam one.
 *
 * Shared by both POSIX-gated blocks below. The fakes are bash scripts, which is
 * also why those blocks skip on Windows: Node cannot spawn a .cmd/.bat without
 * `shell: true`, the same constraint that keeps the launcher's own discovery to
 * `.exe`.
 */
const VERSION_PROBE = ['if [ "$1" = "--version" ]; then echo "oam 0.9.0"; exit 0; fi'];

/** Write an executable stand-in oam into a fresh temp dir; returns its path. */
function writeFake(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "caddy-mcp-fake-oam-"));
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
 * The version gate's TWO causes, and the AUTO half of both.
 *
 * An unparseable `--version` and an old one land in the SAME branch, but the
 * launcher deliberately splits their detail and their remedy: a null version is
 * not "old", and the branch's own comment warns that telling that user to `oam
 * self-update` "sends them after the one cause it definitely is not". Only the
 * too-old + CADDY_MCP_RUNTIME=oam corner was pinned, which left the header's
 * promise -- "An older oam is not an error: the launcher falls back to Node and
 * says so on stderr" -- with no test at all.
 *
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

  it("falls back to Node when the discovered oam is too old", async () => {
    // CADDY_MCP_RUNTIME REMOVED, not set to "auto": auto is the default and the
    // mode every install actually runs in, so the documented fallback has to
    // hold without the variable being present at all.
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: undefined,
      OAM_BIN: writeFake(TOO_OLD),
    });
    expect(res.code, res.stderr).toBe(0);
    // Exit 0 alone would also pass on a launcher that started nothing. The
    // version on stdout is what proves the Node fallback actually SERVED.
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    // Naming the version found is the point of the notice: a silent downgrade is
    // how someone keeps running an oam they meant to update.
    expect(res.stderr).toContain("0.8.9");
    expect(res.stderr).toContain("older than 0.9.0");
    expect(res.stderr).toContain("using Node instead");
  }, 30000);

  it("falls back to Node when oam does not report a readable version", async () => {
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "auto",
      OAM_BIN: writeFake(UNREADABLE),
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^caddy-mcp \d+\.\d+\.\d+/);
    // The other half of the split: this diagnostic must NOT claim a version it
    // never read, because "older than 0.9.0" would send the operator to
    // self-update a binary that never ran.
    expect(res.stderr).toContain("could not be run, or did not report a version");
    expect(res.stderr).toContain("using Node instead");
    expect(res.stderr).not.toContain("self-update");
  }, 30000);

  it("names the unreadable-binary remedy, not self-update, under CADDY_MCP_RUNTIME=oam", async () => {
    // The loud counterpart of the case above, and where the two remedies are
    // actually printed -- auto says only "using Node instead".
    const res = await runLauncher(["--version"], {
      CADDY_MCP_RUNTIME: "oam",
      OAM_BIN: writeFake(UNREADABLE),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not be run, or did not report a version this launcher understands");
    expect(res.stderr).toContain("Check that it is an executable oam binary");
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
