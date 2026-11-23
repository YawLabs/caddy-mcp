#!/usr/bin/env node
// Regenerate the Scoop manifest (scoop-yaw/bucket/<pkg>.json) and Homebrew
// formula (homebrew-yaw/Formula/<cmd>.rb) for a published release, filling in
// the version + per-arch sha256s from the GitHub Release's `.sha256` sidecars.
//
// Everything repo-specific is DERIVED from package.json (command name, repo
// slug, license, description), so this script is copy-paste across @yawlabs/*
// servers -- only the sibling-repo dirs are flags. Mirrors the Yaw Terminal
// release.sh pattern: the manifest repos are checked out next to this one and
// pushed with the gh_woods SSH key -- no CI cross-repo token.
//
// Nothing in this repo's release chain runs in CI -- there is no
// .github/workflows directory at all, only CODEOWNERS. The whole flow is local
// and ordered: release.sh cuts the tag, publishes to npm and creates the GitHub
// release; each platform then runs build-binary-oam.mjs + stage-release-asset.mjs
// by hand and uploads its asset + `.sha256` sidecar to that release; this
// manifest BUMP runs last, because step 1 below downloads those sidecars.
//
//   node scripts/update-manifests.mjs --version 0.60.6 \
//     [--scoop-dir ~/yaw/scoop-yaw] [--homebrew-dir ~/yaw/homebrew-yaw] [--push]
//
// Hashes are pulled with `gh release download v<version> -p '*.sha256'` (needs
// gh auth). Without --push it writes the files and prints the git commands.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const expand = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// Escape a value for the inside of a Ruby double-quoted string literal. The
// backslash goes first, or the backslashes added for the other characters get
// doubled. `#` is escaped only where it starts interpolation (`#{...}`, `#@x`,
// `#$x`) -- an unescaped `#{` in package.json's description would run as Ruby
// when brew loads the formula. A plain `#` ("issue #12") stays as written.
// Raw newlines become `\n` so a multi-line value cannot spill out of the
// one-line `desc` stanza.
export function rubyString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#(?=[{@$])/g, "\\#")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// Render the Homebrew formula (CLI -> formula, NOT cask). Every value that lands
// inside a Ruby string goes through rubyString(), the urls and sha256s included:
// a url carries the --version argument (through the tag) and a sha256 is the
// text of a downloaded release sidecar, so neither is known-safe here. The class
// name is a Ruby constant, which cannot be escaped, so anything but a plain
// CamelCase word is refused.
export function renderFormula({ className, cmd, description, homepage, version, license, proprietary, assets }) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(className)) {
    throw new Error(`cannot use ${JSON.stringify(className)} as a Homebrew formula class name`);
  }
  const licenseLine = proprietary ? "license :cannot_represent" : `license "${rubyString(license)}"`;
  return `class ${className} < Formula
  desc "${rubyString(description)}"
  homepage "${rubyString(homepage)}"
  version "${rubyString(version)}"
  ${licenseLine}

  on_macos do
    on_arm do
      url "${rubyString(assets.macArm64.url)}", using: :nounzip
      sha256 "${rubyString(assets.macArm64.sha256)}"
    end
    on_intel do
      url "${rubyString(assets.macX64.url)}", using: :nounzip
      sha256 "${rubyString(assets.macX64.sha256)}"
    end
  end

  on_linux do
    on_intel do
      url "${rubyString(assets.linuxX64.url)}", using: :nounzip
      sha256 "${rubyString(assets.linuxX64.sha256)}"
    end
  end

  def install
    # Each per-arch release asset is a single bare binary; rename to the command.
    bin.install Dir["*"].first => "${rubyString(cmd)}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${rubyString(cmd)} --version")
  end
end
`;
}

// Refuse a manifest repo whose ROOT is not an existing directory. The write
// below creates missing directories, which is right for `bucket/` or `Formula/`
// inside a real checkout and wrong for the checkout itself: on a machine without
// ~/yaw/scoop-yaw it would build that path and drop a manifest into a directory
// that is no repo at all.
export function requireManifestRepo(dir) {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // missing (or unreadable) -- same answer as "not a directory"
  }
  if (!isDir) {
    throw new Error(
      `manifest repo ${dir}: no such file or directory -- check it out there, or point --scoop-dir / --homebrew-dir (YAW_SCOOP_DIR / YAW_HOMEBREW_DIR) at it`,
    );
  }
}

// Write one manifest into its sibling repo and, with `push`, commit and push it
// (SSH gh_woods, like release.sh). Returns "written", "pushed", or "unchanged"
// when the repo already had this exact manifest committed.
//
// The pull comes BEFORE the write: `git pull --rebase` refuses to start over a
// modified tracked file, and after the write the manifest is exactly that.
// --autostash covers unrelated dirt in the tree. The manifest's OWN leftover
// change -- from a run without --push (the documented review-then-push flow), or
// one that died between the write and the commit -- is discarded before the pull
// instead: the write that follows replaces it anyway, and stashing it would
// conflict with an origin that moved the manifest too (another machine's bump),
// leaving a conflicted file and an orphaned "autostash" entry in `git stash list`.
//
// An unchanged manifest skips the commit, since `git commit` exits 1 on "nothing
// to commit" and would stop a re-run before it reached the second repo. The push
// still runs: a run that committed and then failed to push leaves exactly this
// state, and pushing an up-to-date branch is a no-op.
export function updateManifestRepo(dir, rel, content, { push = false, msg, stdio = "inherit" } = {}) {
  requireManifestRepo(dir);
  const env = { ...process.env, GIT_SSH_COMMAND: "ssh -i ~/.ssh/gh_woods -o IdentitiesOnly=yes" };
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio, env });
  const path = join(dir, rel);
  if (push) {
    let inHead = true;
    try {
      execFileSync("git", ["-C", dir, "cat-file", "-e", `HEAD:${rel}`], { stdio: "ignore", env });
    } catch {
      inHead = false;
    }
    if (inHead) {
      git("checkout", "HEAD", "--", rel);
    } else {
      // A manifest this repo has never committed: drop it from the index and the
      // tree, or a pull that brings the same path in refuses to overwrite it.
      git("rm", "-q", "--cached", "--ignore-unmatch", "--", rel);
      rmSync(path, { force: true });
    }
    git("pull", "--rebase", "--autostash", "origin", "main");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (!push) return "written";
  git("add", rel);
  const changed =
    execFileSync("git", ["-C", dir, "status", "--porcelain", "--", rel], { encoding: "utf-8", env }).trim() !== "";
  // Only the manifest: the autostash can put back unrelated staged work.
  if (changed) git("commit", "-m", msg, "--", rel);
  git("push", "origin", "main");
  return changed ? "pushed" : "unchanged";
}

// Only run the release side effects when executed as a script, so a test can
// import the helpers without triggering `gh release download`. Compare real
// paths, so a run through a symlink or junction to the script still counts as
// direct instead of silently doing nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();

function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const version = arg("version", pkg.version);
  const tag = `v${version}`;

  // Manifest repo paths: resolved in priority order:
  //   1. --scoop-dir / --homebrew-dir CLI flags
  //   2. YAW_SCOOP_DIR / YAW_HOMEBREW_DIR env vars
  //   3. Hardcoded personal-machine defaults (~/yaw/scoop-yaw etc.)
  // On a second machine, set the env vars or pass the flags -- the
  // personal defaults only exist on the original dev machine and will
  // produce a "no such file or directory" error rather than silently
  // writing to a wrong location (requireManifestRepo, checked for both
  // repos before anything is downloaded, written or pushed).
  const scoopDir = resolve(expand(arg("scoop-dir", process.env.YAW_SCOOP_DIR ?? "~/yaw/scoop-yaw")));
  const homebrewDir = resolve(expand(arg("homebrew-dir", process.env.YAW_HOMEBREW_DIR ?? "~/yaw/homebrew-yaw")));
  const push = process.argv.includes("--push");
  requireManifestRepo(scoopDir);
  requireManifestRepo(homebrewDir);

  // --- everything below is derived from package.json (copy-paste generic) ------
  const pkgShort = pkg.name.split("/").pop(); // scoop install name + bucket file
  const cmd = Object.keys(pkg.bin ?? {})[0] ?? pkgShort; // the on-PATH command
  const repoSlug =
    (pkg.repository?.url ?? "")
      .replace(/^git\+/, "")
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "") || `YawLabs/${pkgShort}`;
  const REPO = `https://github.com/${repoSlug}`;
  const homepage = pkg.homepage || REPO;
  // CamelCase the command for the Homebrew class (yaw-mcp -> YawMcp).
  const className = cmd
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const proprietary = !pkg.license || pkg.license === "UNLICENSED";
  const dl = (asset) => `${REPO}/releases/download/${tag}/${asset}`;

  // Per-arch asset names (must match stage-release-asset.mjs: <cmd>-<plat>-<arch>).
  const ASSETS = {
    winX64: `${cmd}-win32-x64.exe`,
    winArm64: `${cmd}-win32-arm64.exe`,
    macArm64: `${cmd}-darwin-arm64`,
    macX64: `${cmd}-darwin-x64`,
    linuxX64: `${cmd}-linux-x64`,
  };

  // 1. Pull every .sha256 sidecar from the release into a temp dir, parse hashes.
  const shaDir = mkdtempSync(join(tmpdir(), `${cmd}-sha-`));
  const hashes = {};
  try {
    execFileSync("gh", ["release", "download", tag, "--repo", repoSlug, "-p", "*.sha256", "-D", shaDir], {
      stdio: "inherit",
    });
    for (const file of readdirSync(shaDir)) {
      const [hex, name] = readFileSync(join(shaDir, file), "utf-8").trim().split(/\s+/);
      hashes[name] = hex;
    }
  } finally {
    rmSync(shaDir, { recursive: true, force: true });
  }
  function hashFor(asset) {
    const h = hashes[asset];
    if (!h) throw new Error(`missing sha256 sidecar for ${asset} in release ${tag}`);
    return h;
  }

  // 2. Scoop manifest (architecture.{64bit,arm64}; x64 is "64bit" in Scoop).
  const scoopManifest = {
    version,
    description: pkg.description,
    homepage,
    license: { identifier: proprietary ? "Proprietary" : pkg.license, url: "https://yaw.sh" },
    architecture: {
      "64bit": { url: dl(ASSETS.winX64), hash: hashFor(ASSETS.winX64), bin: [[ASSETS.winX64, cmd]] },
      arm64: { url: dl(ASSETS.winArm64), hash: hashFor(ASSETS.winArm64), bin: [[ASSETS.winArm64, cmd]] },
    },
    // Belt-and-suspenders: strip any Mark-of-the-Web so SmartScreen never fires
    // (Scoop's own fetch usually leaves none, but a proxied download might).
    post_install: ['Get-ChildItem "$dir\\*.exe" | Unblock-File'],
    checkver: { github: REPO },
    autoupdate: {
      architecture: {
        "64bit": { url: `${REPO}/releases/download/v$version/${ASSETS.winX64}`, hash: { url: "$url.sha256" } },
        arm64: { url: `${REPO}/releases/download/v$version/${ASSETS.winArm64}`, hash: { url: "$url.sha256" } },
      },
    },
  };

  // 3. Homebrew formula.
  const asset = (name) => ({ url: dl(name), sha256: hashFor(name) });
  const formula = renderFormula({
    className,
    cmd,
    description: pkg.description,
    homepage,
    version,
    license: pkg.license,
    proprietary,
    assets: { macArm64: asset(ASSETS.macArm64), macX64: asset(ASSETS.macX64), linuxX64: asset(ASSETS.linuxX64) },
  });

  // 4. Write both manifests into the sibling repos; with --push, commit and
  //    push each one too (see updateManifestRepo for the ordering).
  const scoopRel = `bucket/${pkgShort}.json`;
  const formulaRel = `Formula/${cmd}.rb`;
  const msg = `${cmd} ${version}`;
  for (const [dir, rel, content] of [
    [scoopDir, scoopRel, `${JSON.stringify(scoopManifest, null, 2)}\n`],
    [homebrewDir, formulaRel, formula],
  ]) {
    const result = updateManifestRepo(dir, rel, content, { push, msg });
    console.log(
      `wrote ${join(dir, rel)}${result === "unchanged" ? " (already committed, nothing new to commit)" : ""}`,
    );
  }

  if (push) {
    console.log("pushed scoop-yaw + homebrew-yaw");
  } else {
    console.log("\n--push not set. Review, then:");
    console.log(
      `  git -C ${scoopDir} add ${scoopRel} && git -C ${scoopDir} commit -m "${cmd} ${version}" && git -C ${scoopDir} push`,
    );
    console.log(
      `  git -C ${homebrewDir} add ${formulaRel} && git -C ${homebrewDir} commit -m "${cmd} ${version}" && git -C ${homebrewDir} push`,
    );
  }
}
