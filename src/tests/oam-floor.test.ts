import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Tests for scripts/check-oam-floor.mjs, ported from aws-mcp with its offline
 * cases. The subject lives in scripts/, which tsconfig does not include, so it
 * is exercised as a subprocess, the way release.sh runs it.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-oam-floor.mjs");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A synthetic repo carrying only the files the checker reads. */
function fixture(files: { launcher?: string; readme?: string; launcherTest?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "caddy-mcp-floor-"));
  dirs.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "tests"), { recursive: true });
  writeFileSync(join(root, "bin", "caddy-mcp.mjs"), files.launcher ?? "const OAM_MIN = [0, 16, 3];\n");
  if (files.readme !== undefined) writeFileSync(join(root, "README.md"), files.readme);
  writeFileSync(
    join(root, "src", "tests", "launcher.test.ts"),
    files.launcherTest ?? "    expect(floor).toEqual([0, 16, 3]);\n",
  );
  return root;
}

/** Offline on purpose: these cases are about drift, and the network half is not
 *  theirs to exercise (nor should a unit test depend on GitHub being reachable). */
function runChecker(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, "--offline", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the oam floor is consistent across this repo", () => {
  // The half of the staleness check that needs no network, so it runs on every
  // `npm test` -- which is what makes it gate a release, because release.sh runs
  // the suite. Nobody has to remember to run anything.
  it("the real repo agrees with itself", () => {
    const r = runChecker(REPO_ROOT);
    expect(r.code, `check-oam-floor reported drift in this repo:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/no drift/);
  });
});

describe("check-oam-floor catches drift", () => {
  // A checker with no test that it FAILS is worse than none: the first run of the
  // aws-mcp original had a regex containing literal backspace bytes, so it
  // matched nothing and reported a clean repo.

  it("flags a README still claiming the previous floor", () => {
    const root = fixture({
      readme:
        "This server runs on oam.\n\nThe launcher never serves on an oam older than **0.15.2**, and picks the newest.\n",
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/DRIFT/);
    expect(r.out, "the message must name the file and line").toMatch(/README\.md:3/);
    expect(r.out, "and the version it found").toMatch(/0\.15\.2/);
  });

  it("flags a launcher test still pinning the previous floor", () => {
    const root = fixture({ launcherTest: "    expect(floor).toEqual([0, 15, 2]);\n" });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/pins the floor at 0\.15\.2, but OAM_MIN is 0\.16\.3/);
  });

  it("flags the floor assertion being gone", () => {
    // Removing the pin is drift too: the suite then asserts nothing about the floor.
    const root = fixture({ launcherTest: "    // the floor assertion was deleted\n" });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/no longer pins the floor/);
  });

  it("does NOT flag a line naming a host version beside the floor", () => {
    // The launcher's own diagnostic is "this process is oam 0.9.0, older than
    // <floor>" -- two versions with different roles, both correct.
    const root = fixture({
      launcherTest:
        "    expect(floor).toEqual([0, 16, 3]);\n" +
        "      /this process is oam 0\\.9\\.0, older than 0\\.16\\.3, and no newer oam was found/,\n",
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it("flags a stale claim on a line that also names the current floor", () => {
    const root = fixture({
      readme:
        "| `CADDY_MCP_RUNTIME` | on oam if that is 0.16.3 or newer. An oam host older than 0.15.2 never serves. |\n",
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/README\.md:1 +says 0\.15\.2/);
  });

  it("does NOT flag other dependencies' versions", () => {
    const root = fixture({
      readme: "- Node.js 20.0.0 or newer.\nCaddy 2.11.4 or newer is the minimum this was tested against.\n",
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it("does NOT flag a line that is explicitly about the past", () => {
    const root = fixture({
      readme: "Up to 0.17.1 a port-scoped oam grant admitted no fetch, so the floor moved.\n",
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it("fails loudly when OAM_MIN cannot be found at all", () => {
    const root = fixture({ launcher: "// somebody renamed the constant\n" });
    const r = runChecker(root);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/OAM_MIN/);
  });
});
