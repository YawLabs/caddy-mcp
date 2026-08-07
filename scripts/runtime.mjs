// Runtime selection shared by the build and typecheck scripts.
//
// Policy: oam is the DEFAULT and Node is the FALLBACK. oam is a separate
// TypeScript runtime (https://oamjs.org) that is not an npm dependency, so it
// is never assumed present -- every caller must degrade to the Node path when
// `findOam()` returns null, and a contributor with only Node installed must
// still get a working build and typecheck.
//
// Discovery order:
//   1. $OAM_BIN                   -- explicit path wins (CI images, non-PATH installs)
//   2. the installed locations    -- ~/.oam/bin, %LOCALAPPDATA%\oam\bin
//   3. `oam` on PATH
//   4. null                       -- caller falls back to Node
//
// WHY INSTALLED LOCATIONS OUTRANK PATH
// A developer working on oam itself usually has `oam/target/release` on PATH.
// A binary living in a build output directory is treated as perpetually-changed
// by an on-access virus scanner and gets rescanned on EVERY exec, while an
// installed `node.exe` is signed and long since cached. Any timing that
// compares the two then measures the scanner and blames the runtime.
//
// That is not hypothetical -- it produced a wrong conclusion in this repo. A
// benchmark in build-binary.mjs recorded `oam run` at 853 ms against node's
// 701 ms and concluded oam should not be used at launch. Re-measured with the
// identical bytes outside `target/`: node 386 ms, oam-from-target 432 ms
// (1.12x), oam-warmed-elsewhere 367 ms (0.95x). The sign flips; the scanner
// alone accounts for 1.18x on oam and nothing on node.
//
// Warming does not rescue it: a binary under `target/` stays slow across runs
// with no warm-up curve, because each exec is rescanned. Preferring an
// installed copy is the fix, and saying so loudly is the backstop.
//
// Escape hatch: CADDY_MCP_RUNTIME=node forces the Node path even when oam is
// installed, so a regression can be bisected against the Node toolchain
// without uninstalling anything.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';

const isWin = process.platform === 'win32';
const exeName = isWin ? 'oam.exe' : 'oam';

/**
 * The per-user locations oamjs.org's installers write to. Both forms are
 * checked on Windows: the installer defaults to %LOCALAPPDATA%\oam\bin there,
 * but oam's own docs name ~/.oam/bin first and OAM_INSTALL_DIR can put it
 * either place, so checking only one silently misses a real install.
 */
function installedCandidates() {
  const home = homedir();
  const paths = [join(home, '.oam', 'bin', exeName)];
  if (isWin) {
    paths.unshift(join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'oam', 'bin', exeName));
  }
  return paths;
}

/** Absolute paths for `oam` on PATH, so callers see WHERE it came from. */
function pathCandidates() {
  const found = [];
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? exts : ['']) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : 'oam');
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * True when a path sits inside a Cargo build output directory.
 * Those are the binaries a scanner re-examines on every exec.
 */
export function isBuildTreeBinary(p) {
  const n = p.replaceAll(sep, '/').toLowerCase();
  return n.includes('/target/release/') || n.includes('/target/debug/');
}

/**
 * Resolve an oam executable, or null when oam should not be used.
 * Verifies the binary actually runs -- a stale $OAM_BIN or a broken PATH entry
 * must degrade to Node rather than fail the build.
 *
 * Returns `{ cmd, version, fromBuildTree }`. `fromBuildTree` is true when the
 * only oam available lives under `target/`; callers doing anything
 * timing-sensitive should surface that rather than publish the number.
 *
 * `require: true` makes absence an ERROR instead of a fallback. Used by the
 * binary build, where silently swapping runtimes would make the release
 * artifact depend on workstation state (see the note in build-binary.mjs).
 */
export function findOam({ require = false } = {}) {
  if (process.env.CADDY_MCP_RUNTIME === 'node') {
    if (require) {
      throw new Error('CADDY_MCP_RUNTIME=node conflicts with an explicit request for the oam runtime.');
    }
    return null;
  }

  const candidates = [];
  // An explicit OAM_BIN is an instruction, not a hint -- it is never reordered,
  // and a build-tree path given deliberately is still honoured (flagged, not
  // overridden).
  if (process.env.OAM_BIN) candidates.push(process.env.OAM_BIN);
  // Installed copies before PATH: see the note at the top of this file.
  candidates.push(...installedCandidates());
  candidates.push(...pathCandidates());

  for (const cmd of candidates) {
    if (!existsSync(cmd)) continue;
    try {
      const out = execFileSync(cmd, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { cmd, version: out.trim(), fromBuildTree: isBuildTreeBinary(cmd) };
    } catch {
      // Not executable, wrong arch, or a stale entry -- try the next candidate.
    }
  }

  if (require) {
    throw new Error(
      'CADDY_MCP_RUNTIME=oam was requested but no working oam was found. ' +
        'Set $OAM_BIN to the executable, put `oam` on PATH, or unset CADDY_MCP_RUNTIME ' +
        'to build with the Node SEA carrier.',
    );
  }
  return null;
}

/** One-line banner so build output always states which runtime produced it. */
export function describeRuntime(oam) {
  if (!oam) return `runtime: node ${process.version} (oam not found -- using the Node fallback)`;
  const warning = oam.fromBuildTree
    ? '\n  WARNING: this oam lives in a cargo target/ directory. Builds are fine, but do NOT' +
      '\n  take timings from it -- an on-access scanner rescans build outputs on every exec' +
      '\n  and will make oam look ~1.2x slower than it is. Copy it elsewhere first.'
    : '';
  return `runtime: ${oam.version} (${oam.cmd}) -- set CADDY_MCP_RUNTIME=node to force the Node path${warning}`;
}
