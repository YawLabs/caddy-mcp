#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/caddy-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below.
 *
 * Unlike npmjs-mcp, this server is NOT a zero-dependency bundle -- dist/
 * imports @modelcontextprotocol/sdk and zod from node_modules at runtime. That
 * is fine on both paths: oam does npm resolution against an existing
 * node_modules with CommonJS interop, and it was verified here before this
 * launcher was written (`oam run dist/index.js -- --version` prints the same
 * version Node does).
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Finding the
 * candidates is stat-only, so a machine without oam never pays for a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to serve -- so the
 * launcher is slower than pointing a host at oam directly. Measured on
 * npmjs-mcp (windows-arm64, n=12 medians, spawn to first MCP initialize):
 * oam 116ms, node 172ms, launcher 243ms. It exists for `npx` convenience.
 *
 * For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 installed in ~/.oam/bin
 * and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed locations
 * are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is named
 * on stderr and discovery carries on. It used to stop everything: a typo in
 * OAM_BIN meant Node, with no hint why.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. This launcher used to discover oam and spawn it anyway,
 * so one server cost two runtime boots: measured on Windows, oam.exe with a
 * NESTED oam.exe + conhost.exe underneath it. Now, when `process.versions.oam`
 * clears the same MINIMUM OAM VERSION a discovered binary has to, the server is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 *
 * CADDY_MCP_SANDBOX=1 still takes the discovery path on such a host,
 * deliberately: `--permission` is a process-level flag that only a FRESH oam
 * can apply, so serving in-process on the host would drop the sandbox without
 * a word -- a security downgrade dressed up as an optimisation.
 *
 * A host oam BELOW the floor never serves. It used to, whenever discovery came
 * up empty. It now hands the server off to the newest usable oam, or to Node
 * found on PATH, or exits with an error when there is neither.
 *
 * Every handoff from an oam host PIPES stdio rather than inheriting it. Before
 * 0.9.0 oam treated `stdio: 'inherit'` as `'pipe'`, so an inherited handoff
 * from such a host connected the child to pipes nobody reads: measured with a
 * real oam 0.8.2 host, the MCP handshake never answered. Piping the streams
 * explicitly completes it, to both oam and Node. The sandbox spawn from a
 * supported oam host pipes too -- one rule for every oam host, verified with a
 * real handshake on 0.15.2. A Node host keeps `inherit`, which hands over the
 * same fds untouched.
 *
 * The sandbox asks for a spawn; it does not guarantee one. Discovery can still
 * come up empty -- no usable oam binary, or a spawn that fails -- and under
 * CADDY_MCP_RUNTIME=auto the server then runs WITHOUT `--permission`: in THIS
 * process on Node or on a host oam at the floor, handed off to Node from a host
 * oam below it. The stderr notes name a passed-over OAM_BIN, found binary or
 * .cmd shim, and a failed spawn, but none of them mentions the sandbox, and
 * with nothing found at all the fallback is silent. Only CADDY_MCP_RUNTIME=oam
 * turns that miss into a hard failure, so pair it with CADDY_MCP_SANDBOX=1 when
 * the sandbox has to hold. CADDY_MCP_RUNTIME=node ignores the sandbox entirely.
 *
 * THE `--permission` SANDBOX (opt-in)
 * `CADDY_MCP_SANDBOX=1` runs the server under oam's permission model when an
 * oam binary is found and launched -- see ALREADY RUNNING ON OAM for the
 * fallback that runs it unsandboxed, and how to refuse that instead.
 *
 * The admin API endpoint is DERIVED from CADDY_ADMIN_URL (default
 * http://localhost:2019 -- byte-identical to DEFAULT_URL in src/api.ts, see
 * sandboxFlags). For a TCP endpoint the grant is the HOST, deliberately WITHOUT
 * a port: oam checks `fetch` against the bare hostname and sockets against
 * "host:port", and grants are prefix-matched, so pinning the port denies every
 * fetch -- and fetch is the transport api.ts uses for everything but a unix
 * socket. Granting the host therefore also admits its other ports; that is the
 * cost of the check having no port to match against.
 *
 * A unix-socket CADDY_ADMIN_URL gets NO net grant, which DENIES the category
 * outright -- it is not an oversight that it looks narrower than the TCP case.
 * oam ships no unix socket transport, so the socket dial cannot work under the
 * sandbox regardless; the alternative was a bare `--allow-net`, which grants
 * every host on the network. See sandboxFlags for the mechanism.
 *
 * Child-process stays denied: this server drives Caddy entirely over its admin
 * HTTP API and never shells out to the `caddy` binary (the only execFileSync
 * calls in the repo are in src/tests/). Filesystem stays denied too, EXCEPT when
 * CADDY_MCP_SNAPSHOT_DIR is set: snapshot persistence is the one feature that
 * touches disk, so that directory -- and nothing else -- is granted read+write.
 *
 * Opt-in, not default: a denied environment variable is ABSENT from process.env
 * rather than throwing, so an under-granted CADDY_API_TOKEN reads as
 * "unauthenticated". The env list is derived from the shipped bundle.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over. The
 * floor is not cosmetic: before 0.9.0 `child_process.execFile` ran its
 * arguments through a SHELL, `exec` accepted `timeout` and ignored it,
 * `spawnSync` truncated at `maxBuffer` while reporting success, and
 * `stdio: 'inherit'`/`'ignore'` both behaved as `'pipe'`. The server itself
 * spawns nothing, but this launcher does, and the last of those reached it: an
 * old oam host's inherited handoff never answered the MCP handshake (see
 * ALREADY RUNNING ON OAM).
 *
 * SELECTION
 *   CADDY_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   CADDY_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                            (already running on oam at the floor satisfies
 *                            it, except under CADDY_MCP_SANDBOX=1)
 *   CADDY_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to Node
 *                            on PATH when THIS process is oam
 *   CADDY_MCP_SANDBOX=1      run the spawned oam under --permission; under
 *                            auto a discovery miss still runs unsandboxed
 *   OAM_BIN=/path/to/oam     use this oam when it is usable, before discovery
 * The runtime value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam this server is served on. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and a build directory is the wrong
 * thing to prefer at equal versions: cargo replaces the binary underneath
 * running processes, and the dev build is not the release the user installed.
 * A NEWER build on PATH still wins -- the newest usable oam is the rule -- and
 * OAM_BIN remains the way to point deliberately at one.
 *
 * Both installed forms are checked on Windows: the installer defaults to
 * %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin first and
 * OAM_INSTALL_DIR can pick either, so checking one silently misses a real
 * install.
 *
 * PATH is resolved manually rather than by spawning `which`/`where`, which
 * would cost a subprocess on every launch just to decide whether to spawn.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would only collect paths this launcher cannot execute.
 * Discovery has to agree with execution. A skipped shim is still reported --
 * see findOamShim.
 *
 * scripts/runtime.mjs carries its OWN findOam that DOES walk the full PATHEXT.
 * That is a deliberate difference, not drift: it serves the build and
 * typecheck scripts, drops whatever fails its execFileSync probe, and has no
 * diagnostic to give, so a wider walk there only ever finds more. Here a
 * collected .cmd would cost a probe that cannot succeed, and add a "could not
 * be run" note beside the shim note that actually says what to do about it.
 * Same question, different constraint; change one and re-read the other.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.1") and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back when none is usable
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  Node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. `sandbox` is whether a spawn would carry flags
 * only a fresh oam can apply; see ALREADY RUNNING ON OAM above for why that
 * alone forces discovery -- and why discovery is not a guaranteed spawn. The
 * floor is OAM_MIN itself, not a parameter, so a host oam and a discovered one
 * can never be held to different minimums.
 *
 * A host oam below the floor gets "discover", not a handoff straight to Node:
 * a newer oam may still be found, and when none is, the fallback hands off to
 * Node rather than serving on the host.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they belong before the `run` subcommand,
 * not after it. `oam run --permission file.js` is rejected outright, which is a
 * good failure but only because it is loud -- ordering here is load-bearing.
 *
 * Net grants prefix-match `host` for fetch and `host:port` for sockets.
 * A denied environment variable is ABSENT from process.env rather than throwing,
 * so the env list below is derived from what the bundle actually reads; trimming
 * it produces silent misbehaviour, not a clear denial.
 */
function sandboxFlags() {
  if (process.env.CADDY_MCP_SANDBOX !== "1") return [];

  // Derived, not hardcoded: the only endpoint this server may reach is the one
  // it was configured to reach. A DSN we cannot parse falls back to a bare grant
  // rather than a broken one, because a wrong narrow grant fails at connect time.
  //
  // The default MUST stay byte-identical to DEFAULT_URL in src/api.ts. The grant
  // and the dial are matched as TEXT, so "127.0.0.1" here against an api.ts that
  // dials "localhost" denies every request while both files look right on their
  // own. Change one, change the other.
  //
  // Empty and whitespace-only are treated as UNSET, which is what api.ts does:
  // it reads the variable with `||`, so "" already falls through to DEFAULT_URL
  // there. `??` would keep "" here, skip the parse, and leave the bare
  // `--allow-net` below -- a wide-open sandbox produced by a shell exporting an
  // empty variable, which is a shape shells produce easily.
  const dsn = process.env.CADDY_ADMIN_URL?.trim() || "http://localhost:2019";

  // A unix-socket admin endpoint gets NO net grant at all -- checked before the
  // URL parse, because it is the one input that would otherwise produce the
  // WIDEST grant instead of the narrowest.
  //
  // `new URL("unix:///run/caddy.sock").hostname` is "", so the `if (u.hostname)`
  // below is false and netFlag would stay the bare `--allow-net`; Caddy's own
  // spelling (`unix//run/caddy.sock`) throws ERR_INVALID_URL and reaches the
  // catch for the same result. Either way the most hardened admin config --
  // Caddy recommends the socket precisely because filesystem permissions beat a
  // loopback port -- would switch the sandbox on and hand over the whole network.
  // That is the same wide-open-by-accident shape the empty-string case above
  // guards against, reached by a different route.
  //
  // Omitting the flag DENIES the category (oam reads an absent --allow-net as
  // false, a bare one as "*"), and denial costs nothing here: oam has no unix
  // socket transport at all, so api.ts's node:http `socketPath` dial cannot work
  // under oam whether the grant is open or closed. Re-verified against oam 0.15.2 --
  // bare grant lets an unrelated host through, omitted grant denies it.
  //
  // This mirrors getMalformedUnixUrl's predicate in src/api.ts, NOT the stricter
  // getUnixSocketPath -- deliberately, and the difference is the whole point.
  //
  // getUnixSocketPath accepts only the two WELL-FORMED spellings; matching it
  // here would leave the malformed ones ("unix:/one-slash", "unix://relative",
  // "unix://", or any uppercase spelling, which getUnixSocketPath rejects for
  // case) falling through to the parse, where they yield an empty hostname and
  // the bare `--allow-net` -- fully open, for input that plainly meant a socket.
  //
  // Denying the category for those costs nothing: api.ts routes exactly this set
  // to getMalformedUnixUrl, which fails the request up front with a message
  // naming the spelling error, so no request is ever attempted. Matching the
  // broad predicate is what makes the header's claim true for EVERY unix-ish
  // input rather than just the two tidy ones.
  //
  // `[:/]` after "unix" rather than a bare "unix" prefix, so a real TCP host like
  // "http://unix.example.com:2019" is not swept up -- the same care api.ts takes.
  const isUnixDsn = /^unix[:/]/i.test(dsn);

  let netFlag = isUnixDsn ? null : "--allow-net";
  if (!isUnixDsn) {
    try {
      const u = new URL(dsn);
      // HOST ONLY, no port, deliberately. Grants are prefix-matched against the
      // resource string, and the resource `fetch` presents is the bare hostname
      // ("localhost") while sockets present "host:port". "localhost" does not
      // start with "localhost:2019", so pinning the port denies every fetch --
      // and fetch is how api.ts talks to a TCP admin endpoint. Granting the host
      // alone also admits the other ports on that host; that is the cost of the
      // check having no port to match against, not an oversight here.
      if (u.hostname) netFlag = `--allow-net=${u.hostname}`;
    } catch {
      // Genuinely unparseable CADDY_ADMIN_URL (not the unix forms -- those are
      // handled above): leave the grant open. The server will fail on its own
      // connection error, which names the real problem.
    }
  }

  // Every variable the shipped bundle reads (`grep process.env src/`), including
  // CADDY_MCP_SNAPSHOT_DIR in src/snapshots.ts. Omitting one is not a denial the
  // operator can see: the variable is simply ABSENT, so the feature reads as
  // "not configured" and degrades silently.
  const env = [
    "CADDY_ADMIN_URL",
    "CADDY_API_TOKEN",
    "CADDY_LOAD_TIMEOUT",
    "CADDY_MAX_RETRIES",
    "CADDY_MCP_SNAPSHOT_DIR",
    "CADDY_TIMEOUT",
  ];

  // netFlag is null for a unix DSN -- an OMITTED --allow-net is what denies the
  // category, so it must not survive as a stray "null" argv entry.
  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`].filter(Boolean);

  // The filesystem grant exists only when snapshot persistence is switched on,
  // and only for the directory it points at. Granting the variable without the
  // directory would just move the silent failure: src/snapshots.ts swallows its
  // own I/O errors and degrades to the in-memory ring, so `caddy_revert` would
  // quietly stop surviving a restart -- the thing the operator turned the
  // variable on to get.
  //
  // TWO spellings, because grants are matched as plain string PREFIXES against
  // whatever path each call passes: snapshots.ts hands the raw variable to
  // readdirSync/mkdirSync but builds per-file paths with path.join, which
  // normalizes ("./snaps" -> "snaps"). The raw form alone then misses the files;
  // the normalized form alone misses the directory listing.
  //
  // Two consequences worth naming rather than discovering: a prefix also admits
  // a sibling path that merely starts with the same string ("/var/snap" grants
  // "/var/snapshots-elsewhere"), and oam splits the list on commas with no
  // escape, so a directory whose path contains a comma cannot be granted here.
  const snapshotDir = process.env.CADDY_MCP_SNAPSHOT_DIR?.trim();
  if (snapshotDir) {
    const forms = [...new Set([snapshotDir, join(snapshotDir, ".")])].join(",");
    flags.push(`--allow-fs-read=${forms}`, `--allow-fs-write=${forms}`);
  }

  return flags;
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Reported rather than ignored, because "no oam binary was found"
 * reads as "install oam" -- the one thing that will not help. Windows only;
 * there is no such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. Two causes need two details: a
 * null version is NOT "old" -- the binary could not be run at all (not
 * executable, wrong arch, wedged, deleted between the stat and the probe) or
 * its output did not parse -- so it must not be described as one that needs
 * an update.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. aws-mcp does exactly this. Importing the server here would leave
  // argv[1] pointing at THIS launcher, the guard would read false, and the
  // server would load but never serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process fallback. runInProcess() is a bare
// import() that rejects when dist/index.js is missing, and at ESM top level an
// unhandled rejection is an uncaught exception -- replacing this launcher's
// diagnostic with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`caddy-mcp: fallback to Node failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor, or a supported one
  // spawning a fresh oam for CADDY_MCP_SANDBOX=1. Below the floor
  // `stdio: 'inherit'` does not hand over the fds, so pipe explicitly on every
  // oam host; see ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started -- and stdin piped into a child that never
  // ran would swallow the host's first bytes before the fallback could read
  // them. Until 'spawn', process.stdin has no reader and simply stays paused.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
  // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
  // a wall-clock step cannot mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill (verified: a child with a SIGTERM handler never runs
  // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
  // graceful shutdown the console's own Ctrl-C just started, skipping the
  // child's process.on("exit") cleanup. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  // 5s, not 2s. This is a HARD kill of a server that may be mid-shutdown --
  // flushing a large config, finishing a TLS provision -- and the cost of
  // waiting too long (a wedged child lingers a few extra seconds) is far
  // smaller than the cost of cutting a legitimate shutdown short. The window
  // only ever elapses when the child has NOT exited on its own.
  const ESCALATE_AFTER_MS = 5000;
  let escalation = null;
  function forwardSignals() {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor with no newer oam, or any oam under
 * CADDY_MCP_RUNTIME=node -- so there is no in-process option left.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    await errSync(
      `caddy-mcp: ${reason}, and no Node was found on PATH to run the server instead.\n` +
        `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`,
    );
    process.exit(1);
  }
  if (reason) await errSync(`caddy-mcp: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`caddy-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/**
 * True when THIS process may serve without spawning: it is Node, or an oam at
 * or above the floor. The second is reachable after discovery only under
 * CADDY_MCP_SANDBOX=1, and serves WITHOUT --permission; see ALREADY RUNNING ON
 * OAM.
 */
function hostMayServe(hostOam) {
  return hostOam === undefined || atLeast(parseVersion(hostOam), OAM_MIN);
}

/** What the fallback below will do, for the tail of a stderr note. */
function fallbackTail(hostOam) {
  return hostOam !== undefined && hostMayServe(hostOam)
    ? `serving in this process (oam ${hostOam}) instead`
    : "using Node instead";
}

/**
 * No oam was spawned, under a mode that allows serving without one. Serve in
 * THIS process when it may, otherwise -- a host oam below the floor -- hand off
 * to Node.
 */
async function fallBack(hostOam) {
  if (hostMayServe(hostOam)) {
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and no newer oam was found`);
}

const mode = (process.env.CADDY_MCP_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;

// The sandbox is read off the grant list rather than CADDY_MCP_SANDBOX, so
// "would the spawn carry --permission" cannot drift from what the spawn below
// actually passes.
const plan = runtimePlan({ mode, hostOam, sandbox: sandboxFlags().length > 0 });

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote)
      await errSync(`caddy-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    // `--` separates oam's own flags from the script's argv, so `caddy-mcp
    // --version` and any host-supplied flags survive the hop unchanged. The
    // sandbox flags are process-level, so they go BEFORE `run`.
    await launchChild(
      chosen.path,
      [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)],
      async (err) => {
        if (mode === "oam") {
          await errSync(`caddy-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
          process.exit(1);
        }
        await errSync(
          `caddy-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err}); ${fallbackTail(hostOam)}.\n`,
        );
        await fallBack(hostOam);
      },
    );
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      await errSync(
        `caddy-mcp: CADDY_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use CADDY_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong or their oam is too old to use.
    if (notes.length > 0) await errSync(`caddy-mcp: ${notes.join("; ")}; ${fallbackTail(hostOam)}.\n`);
    await fallBack(hostOam).catch(fallbackFailed);
  }
}
