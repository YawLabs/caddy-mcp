#!/usr/bin/env node
/**
 * Run biome against a binary that actually works on this host.
 *
 * Everywhere except Windows ARM64 this is a thin passthrough to the platform
 * binary npm installed. On Windows ARM64 it provisions the x64 build OF THE
 * SAME VERSION into a gitignored cache and runs that under emulation instead.
 *
 * Why: SOME `@biomejs/cli-win32-arm64` builds are broken, and which ones is not
 * predictable from the version number. Measured on a win32-arm64 host
 * (2026-09-11): 2.5.4 exits 139 on every invocation path -- the `.bin/biome`
 * shim, `biome.cmd` from PowerShell (STATUS_ACCESS_VIOLATION 0xC0000005), and
 * the binary invoked directly with no npm in the picture -- while 2.4.16 and
 * 2.5.13 both run correctly on the same host (exit 0 on a clean tree, exit 1
 * naming the file on a real finding). So this is neither a permanent arm64
 * defect nor a fault in npm's run-script wrapper: it is a per-version
 * packaging bug in the arm64 executable.
 *
 * The x64 build of every version measured runs fine under Windows' x64
 * emulation, so routing through it on this host trades a little startup time
 * for a result that does not depend on whether the version currently installed
 * happens to be one of the broken ones. `YAWLABS_BIOME_NATIVE=1` runs the
 * platform binary anyway, which is correct on any version whose arm64 build is
 * unaffected.
 *
 * Why this is a script and not a devDependency: npm refuses to install
 * `@biomejs/cli-win32-x64` on an arm64 host (EBADPLATFORM), which is precisely
 * the situation we are working around, so it cannot be declared normally. The
 * install below passes `--force` for that reason and `--no-save` so the
 * workaround never leaks into package.json.
 *
 * Why it matters here specifically: this repo has no .github/workflows at all
 * and GitHub Actions is disabled on it, so there is no runner to arbitrate
 * formatting later. (release.sh has a CI-mode branch, but no workflow exists to
 * run it.) Whatever this script reports is the ONLY lint signal that exists
 * before `release.sh` publishes to npm.
 *
 * Escape hatches, in case the platform assumption ages badly:
 *   YAWLABS_BIOME_BIN=<path>   use exactly this binary, skip all detection
 *   YAWLABS_BIOME_NATIVE=1     force the normal platform binary on any host
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

/**
 * Every spawn below is bounded, because `npm run lint` runs UNATTENDED as
 * release.sh step 1 -- an unbounded child there turns a WEDGED release rather
 * than a failed one, with no output to say why.
 *
 * Deliberately generous -- these convert an infinite hang into a reported
 * failure, they are not performance budgets. For scale, biome checks this repo
 * in well under a second.
 */
const PROBE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LINT_TIMEOUT_MS = 10 * 60_000;

/**
 * The biome version to provision: the one this repo actually INSTALLS, read
 * from package-lock.json and falling back to the installed package itself.
 *
 * It used to be read out of biome.json's `$schema` URL, and that was a bug.
 * `$schema` pins the version the CONFIG is validated against; it is not the
 * binary the repo installs, and the two drift apart the moment a `^`/`~` range
 * resolves forward while the hand-written schema URL stays where it was. They
 * had already drifted here: `$schema` says 2.4.11 while the lockfile installs
 * 2.4.16, so on this host the gate was checking the tree with a version the
 * repo does not use anywhere else -- and any finding the two versions disagree
 * about was invisible. Sourcing it from the lockfile makes "lint clean" mean
 * clean under the binary every other host runs.
 */
function installedBiomeVersion() {
  const lockPath = join(repoRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const locked = JSON.parse(readFileSync(lockPath, "utf8")).packages?.["node_modules/@biomejs/biome"];
    if (locked?.version) return locked.version;
  }

  // No lockfile entry (a fresh `npm i --no-save`, a pruned lockfile): the
  // installed package is the same answer, just less durable.
  const pkgPath = join(repoRoot, "node_modules", "@biomejs", "biome", "package.json");
  if (existsSync(pkgPath)) {
    const installed = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (installed) return installed;
  }

  throw new Error(
    "Could not determine which @biomejs/biome version this repo installs, so the x64\n" +
      "build to provision is unknown. Looked for:\n" +
      `  ${lockPath} -> packages["node_modules/@biomejs/biome"].version\n` +
      `  ${pkgPath} -> version\n` +
      "Run `npm install` (or `npm ci`) first, or set YAWLABS_BIOME_BIN=<path to a working\n" +
      "biome> to skip version resolution entirely.",
  );
}

/** The platform binary npm installed for THIS host, or null when absent. */
function nativeBinary() {
  const pkg = `@biomejs/cli-${process.platform}-${process.arch}`;
  const direct = join(repoRoot, "node_modules", ...pkg.split("/"), `biome${exe}`);
  if (existsSync(direct)) return direct;
  // musl and other suffixed variants (cli-linux-x64-musl) don't match the plain
  // name above; fall back to the shim npm links, which is correct everywhere the
  // native binary is not itself broken.
  const shim = join(repoRoot, "node_modules", ".bin", isWindows ? "biome.cmd" : "biome");
  return existsSync(shim) ? shim : null;
}

/**
 * Resolve npm's own CLI entry point so the install below can be spawned through
 * `node` with NO shell.
 *
 * Both halves of that matter on Windows. `npm` on PATH is `npm.cmd`, and
 * spawning a `.cmd` with `shell: false` throws EINVAL on Node 22 -- but turning
 * the shell ON makes cmd.exe re-split the argv on whitespace, so a repo path
 * containing a space arrives as two arguments and the second is read as a
 * package name. (Measured: `--prefix "C:\a b\c"` becomes
 * `["--prefix","C:a","bc"]`.) Spawning node with npm-cli.js sidesteps both.
 */
function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Provision (once per version) and return the emulated x64 binary. Installs
 * into node_modules/.cache, which is already gitignored via node_modules/ and
 * is wiped by `npm ci` -- the next run simply re-installs it.
 *
 * The version is part of the DIRECTORY NAME, not just the install argument.
 * Keying the cache on presence alone would silently reuse a stale binary after
 * a biome bump -- defeating the whole point of sourcing the version from the
 * lockfile, since the tree would still be checked by the version the repo used
 * to install rather than the one it installs now. A version-stamped path also
 * means an install interrupted midway leaves a directory that the NEXT bump
 * abandons rather than trusts; the explicit re-verify below covers the
 * same-version case.
 */
function emulatedX64Binary(version) {
  const prefix = join(repoRoot, "node_modules", ".cache", `biome-x64-${version}`);
  const bin = join(prefix, "node_modules", "@biomejs", "cli-win32-x64", "biome.exe");

  // Presence is not validity: an install killed partway through leaves a
  // truncated .exe that would otherwise be cached forever. Confirm the binary
  // actually runs and reports the version we asked for before trusting it.
  if (existsSync(bin)) {
    // Bounded: a corrupt-but-executable binary, or one stalled inside the x64
    // emulation layer, would otherwise hang every lint invocation forever. A
    // timeout leaves `status` null, which fails the check below and routes into
    // the discard path -- the right answer for a binary that cannot answer
    // `--version` in 30 seconds.
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (probe.status === 0 && String(probe.stdout).includes(version)) return bin;
    // DISCARD the tree rather than reinstalling over it. `npm i` treats an
    // already-present package as satisfied -- even with --force -- so installing
    // on top of a truncated binary is a silent no-op that leaves the corruption
    // in place and re-runs npm on every subsequent invocation. Measured: a
    // 7-byte biome.exe survived the reinstall and lint kept failing.
    //
    // Bounded on purpose: `prefix` is a version-stamped directory this script
    // created under the repo's own node_modules/.cache, never a user-supplied
    // or shared path.
    console.error(`[lint] cached biome at ${bin} is unusable or not ${version}; discarding and re-provisioning`);
    rmSync(prefix, { recursive: true, force: true });
  }

  const npmCli = npmCliPath();
  if (!npmCli) {
    throw new Error(
      "Could not locate npm-cli.js next to this node install, so the x64 biome cannot be\n" +
        "provisioned without a shell (see npmCliPath). Set YAWLABS_BIOME_BIN=<path to a\n" +
        "working biome> instead.",
    );
  }

  console.error(`[lint] routing around the win32-arm64 biome build; provisioning x64 ${version} under emulation`);
  const install = spawnSync(
    process.execPath,
    [npmCli, "i", "--no-save", "--force", "--prefix", prefix, `@biomejs/cli-win32-x64@${version}`],
    { stdio: "inherit", shell: false, timeout: INSTALL_TIMEOUT_MS },
  );
  if (install.status !== 0 || !existsSync(bin)) {
    // Distinguish the two failures: a registry stall and a genuine install
    // error need different responses, and "npm exited null" says neither.
    const why =
      install.error && install.error.code === "ETIMEDOUT"
        ? `npm did not finish within ${INSTALL_TIMEOUT_MS / 1000}s and was killed`
        : `npm exited ${install.status}`;
    throw new Error(
      `Failed to provision @biomejs/cli-win32-x64@${version} (${why}).\n` +
        "This repo has no CI, so there is no other lint signal. Fix the install, or set\n" +
        "YAWLABS_BIOME_BIN=<path to a working biome> to point this script at one.",
    );
  }
  return bin;
}

function resolveBinary() {
  if (process.env.YAWLABS_BIOME_BIN) return process.env.YAWLABS_BIOME_BIN;

  // Unconditional on win32-arm64 rather than "probe the native binary first":
  // the broken builds crash rather than reporting anything, so a probe that
  // passes is not evidence the real `check` run will, and the x64 build of the
  // same version is correct on every host either way.
  const preferEmulatedX64 = isWindows && process.arch === "arm64" && process.env.YAWLABS_BIOME_NATIVE !== "1";
  if (preferEmulatedX64) return emulatedX64Binary(installedBiomeVersion());

  const native = nativeBinary();
  if (!native) {
    throw new Error("No biome binary found in node_modules -- run `npm install` first.");
  }
  return native;
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(`[lint] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Exit with biome's own status so `npm run lint` stays a usable gate, and so a
// non-zero result is a real finding rather than this wrapper's opinion.
//
// `shell` is enabled ONLY for a .cmd/.bat target: spawning one with shell:false
// throws EINVAL on Node 22 (the `.bin/biome.cmd` shim fallback, and any
// YAWLABS_BIOME_BIN pointing at a batch file). Everything else -- including
// every normal .exe path -- stays shell-free so arguments are passed verbatim.
const needsShell = /\.(cmd|bat)$/i.test(binary);
const run = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", shell: needsShell, timeout: LINT_TIMEOUT_MS });
// Checked BEFORE the generic error and crash branches: a timeout kill sets
// `signal` to SIGTERM, which the crash check below would otherwise report as
// the known native-binary crash -- the wrong diagnosis entirely.
if (run.error && run.error.code === "ETIMEDOUT") {
  console.error(
    `[lint] biome did not finish within ${LINT_TIMEOUT_MS / 60_000} minutes and was killed (${binary}). ` +
      "That is far past a normal run, so treat it as a hung binary rather than a slow one.",
  );
  process.exit(1);
}
if (run.error) {
  console.error(`[lint] could not execute ${binary}: ${run.error.message}`);
  process.exit(1);
}
// A native crash surfaces differently by platform: POSIX reports a signal,
// while Windows reports an NTSTATUS as the exit CODE and leaves signal null
// (measured: the arm64 biome access violation is status 3221225477 / 0xC0000005,
// signal null). Checking only `signal` meant this diagnostic could never fire on
// the one host it was written for.
const crashed = run.signal !== null || (run.status ?? 0) >= 0xc0000000;
if (crashed) {
  const how = run.signal ? `killed by ${run.signal}` : `crashed with 0x${(run.status >>> 0).toString(16)}`;
  console.error(
    `[lint] biome ${how} (${binary}).\n` +
      "On Windows ARM64 some biome versions ship an arm64 executable that crashes exactly\n" +
      "like this; this script normally routes around it by running the x64 build of the\n" +
      "same version, so check the YAWLABS_BIOME_BIN / YAWLABS_BIOME_NATIVE overrides.",
  );
  process.exit(1);
}
process.exit(run.status ?? 1);
