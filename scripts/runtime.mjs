// Runtime selection shared by the build and typecheck scripts.
//
// Policy: oam is the DEFAULT and Node is the FALLBACK. oam is a separate
// TypeScript runtime (https://oamjs.org) that is not an npm dependency, so it
// is never assumed present -- every caller must degrade to the Node path when
// `findOam()` returns null, and a contributor with only Node installed must
// still get a working build and typecheck.
//
// Discovery order:
//   1. $OAM_BIN            -- explicit path wins (CI images, non-PATH installs)
//   2. `oam` on PATH
//   3. null                -- caller falls back to Node
//
// Escape hatch: CADDY_MCP_RUNTIME=node forces the Node path even when oam is
// installed, so a regression can be bisected against the Node toolchain
// without uninstalling anything.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve an oam executable, or null when oam should not be used.
 * Verifies the binary actually runs -- a stale $OAM_BIN or a broken PATH entry
 * must degrade to Node rather than fail the build.
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
  if (process.env.OAM_BIN) candidates.push(process.env.OAM_BIN);
  candidates.push(process.platform === 'win32' ? 'oam.exe' : 'oam');

  for (const cmd of candidates) {
    // An explicit OAM_BIN that does not exist is a configuration mistake worth
    // skipping quietly; PATH lookups are validated by the probe below.
    if (cmd === process.env.OAM_BIN && !existsSync(cmd)) continue;
    try {
      const out = execFileSync(cmd, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { cmd, version: out.trim() };
    } catch {
      // Not installed, not executable, or not on PATH -- try the next candidate.
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
  return oam
    ? `runtime: ${oam.version} (${oam.cmd}) -- set CADDY_MCP_RUNTIME=node to force the Node path`
    : `runtime: node ${process.version} (oam not found -- using the Node fallback)`;
}
