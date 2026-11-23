#!/usr/bin/env node
// Stage the host-built oam binary as a named release asset + sha256 sidecar.
//
// build-binary-oam.mjs emits bin/<platform>-<arch>/caddy-mcp(.exe) -- both
// scripts derive that name from package.json's first `bin` key rather than
// hardcoding it, which is what keeps them copy-paste generic across @yawlabs/*
// servers. This renames it to the public asset name the Scoop/Homebrew manifests
// point at (caddy-mcp-<platform>-<arch>[.exe]) and writes a `<asset>.sha256`
// sidecar in sha256sum format (`<hex>  <asset>`) that Scoop's autoupdate
// `hash.url` reads.
//
// The build is host-native (oam compile cannot cross-compile without an explicit
// carrier), so every platform you ship needs its own run of build-binary-oam.mjs
// + this script. There is no CI matrix doing that here -- this repo has no
// .github/workflows at all, so it is a manual per-host step (see
// update-manifests.mjs for the full release chain).
//
// Pure stdlib; writes only to dist-release/. Run after build-binary-oam.mjs:
//   node scripts/stage-release-asset.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
// Binary name = first `bin` command -- keeps this generic across servers.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
const platformArch = `${process.platform}-${process.arch}`;
const builtExe = join(repoRoot, "bin", platformArch, `${binName}${ext}`);
const assetName = `${binName}-${platformArch}${ext}`;

const outDir = join(repoRoot, "dist-release");
const outAsset = join(outDir, assetName);
const outSha = `${outAsset}.sha256`;

// Refuse a stale binary. bin/<platform>-<arch>/ is not rebuilt by anything but
// build-binary-oam.mjs, so a release that skips that step would otherwise stage
// whatever an earlier build left there under the new version's hash (seen: a
// 2.6.0 binary on disk while package.json said 2.6.3). `--version` is the only
// safe probe -- every other argv starts the stdio server and waits on stdin --
// and the timeout keeps a binary that ignores it from hanging the release.
let reported;
try {
  reported = execFileSync(builtExe, ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
} catch (e) {
  console.error(`stage-release-asset: could not run ${builtExe} --version: ${e?.message ?? e}`);
  console.error("Build it first: node scripts/build-binary-oam.mjs");
  process.exit(1);
}
const builtVersion = /(\d+\.\d+\.\d+\S*)\s*$/.exec(reported.trim())?.[1];
if (builtVersion !== pkg.version) {
  console.error(
    `stage-release-asset: ${builtExe} reports ${builtVersion ?? JSON.stringify(reported.trim())}, ` +
      `but package.json is ${pkg.version}. Refusing to stage a stale binary -- rebuild it with ` +
      "node scripts/build-binary-oam.mjs.",
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
rmSync(outAsset, { force: true });
copyFileSync(builtExe, outAsset);
// Preserve the executable bit on Unix (copyFileSync drops it) so the staged
// asset is runnable for the CI smoke test and after download.
if (!isWin) chmodSync(outAsset, 0o755);

const hex = createHash("sha256").update(readFileSync(outAsset)).digest("hex");
// sha256sum format so `sha256sum -c` and Scoop's hash.url sidecar both parse it.
writeFileSync(outSha, `${hex}  ${assetName}\n`);

console.log(`asset:  ${outAsset}`);
console.log(`sha256: ${hex}`);
// A no-op in this repo, which has no workflows: kept because this script is
// copy-pasted into @yawlabs/* siblings that DO run it under Actions, where a
// downstream job reads the asset name and hash as step outputs.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `asset=${assetName}\nsha256=${hex}\n`, { flag: "a" });
}
