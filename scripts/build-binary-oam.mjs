#!/usr/bin/env node
// Build a self-contained single-file binary of the @yawlabs/caddy-mcp server
// using `oam compile`.
//
// Output path is bin/<platform>-<arch>/<binName>[.exe], which is what
// scripts/stage-release-asset.mjs and the release flow consume.
//
// `oam compile` embeds a pre-bundled file into oam's runtime carrier and writes
// the finished executable directly: no blob generation, no injection step, no
// fuse sentinel -- unlike the Node Single Executable Application path this repo
// used to carry, which is gone.
//
// CRITICAL: the bundle handed to `oam compile` MUST be CJS. `oam compile` runs
// the embedded file as CommonJS, and esbuild's ESM banner is not valid there.
// So we re-bundle as CJS here with a banner/define pair that polyfills
// import.meta.url, rather than reusing dist/index.js.
//
// Measured on windows-arm64 against this bundle (7-run averages, `--version`
// to isolate startup):
//
//     node dist/index.js    730 ms   (needs node + node_modules)
//     oam compiled binary   529 ms   57.53 MB
//
// oam precompiles the bundle to bytecode at compile time, which is where the
// compiled binary's startup win comes from.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { describeRuntime, findOam } from "./runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const isWin = process.platform === "win32";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script is
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
// Resolve the TypeScript entry directly rather than deriving it from `bin`.
// `bin` points at the oam runtime LAUNCHER (bin/caddy-mcp.mjs), so deriving the
// source from it would produce `bin/caddy-mcp.ts` -- a path that has never
// existed -- and esbuild would fail with "Could not resolve". Pin the
// conventional source entry, and fail loudly if it moves.
const srcEntry = "src/index.ts";
if (!existsSync(join(repoRoot, srcEntry))) {
  console.error(`build-binary-oam: source entry '${srcEntry}' does not exist -- update this constant`);
  process.exit(1);
}

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, "bin", platformDir);
const tmpDir = join(repoRoot, "build-tmp");
const bundlePath = join(tmpDir, "oam-bundle.cjs");
const exeName = isWin ? `${binName}.exe` : binName;
const outExe = join(binDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

// The carrier is a release artifact, so it must not depend on what happens to
// be installed on the build host: a missing oam is a hard ERROR, never a quiet
// downgrade to a different artifact.
const oam = findOam({ require: true });
console.log(describeRuntime(oam));

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file via esbuild's JS API (NOT the CLI bin:
// on Linux/macOS node_modules/esbuild/bin/esbuild is the native binary, not a
// JS shim). See the CRITICAL note above for why CJS is not optional here.
await esbuild.build({
  entryPoints: [join(repoRoot, srcEntry)],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // esbuild leaves import.meta.url EMPTY in cjs output, so a server that reads
  // it (e.g. createRequire(import.meta.url) to find package.json) crashes at
  // load. Polyfill it to the carrier's own path (__filename is the executable
  // in the compiled binary). Version reads still prefer the __VERSION__ define.
  banner: { js: "const __oamImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), "import.meta.url": "__oamImportMetaUrl" },
  // Optional native addons some servers pull transitively are require()'d
  // inside try/catch; mark them external so esbuild doesn't choke on the .node
  // binary -- they degrade gracefully when absent.
  external: ["cpu-features"],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Embed the bundle into oam's runtime carrier. There is no separate
// blob-generation or injection step -- compile writes the finished executable
// directly.
rmSync(outExe, { force: true });
run(oam.cmd, ["compile", bundlePath, "-o", outExe]);
if (!isWin) chmodSync(outExe, 0o755);

// macOS: Apple Silicon SIGKILLs a Mach-O with no/invalid signature at exec.
// oam's compile step embeds a payload the same way, so ad-hoc re-sign and then
// actually run the binary -- --verify proves the signature is intact, not that
// it launches. Untested on darwin at authoring time (built on windows-arm64);
// kept so a failure here is visible rather than silent.
if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", "--force", "--timestamp=none", outExe]);
  run(outExe, ["--version"]);
}

console.log("");
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log("");
// `--version` is the ONLY safe probe to print here. src/index.ts falls through
// to startServer() for every other argv, so any invented subcommand does not
// error -- it starts the stdio server and HANGS waiting on stdin.
console.log("Verify with:");
console.log(`    "${outExe}" --version`);
